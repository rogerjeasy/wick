/** Entrypoint: wires the real AWS clients into the server. Local dev and the App Runner container both run this. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { DEFAULT_POLICY } from '@wick/policy';
import { DEMO_DOOR_DETAIL_TYPE, DEMO_DOOR_SOURCE, type DemoDoorEvent } from '@wick/contracts';
import { sendHomeToDevices, sendPatchToDevice, sendToDevice, takeBackFromDevices } from '@wick/agent';
import { createApp, SERVER_VERSION } from './server.js';
import { errandMachineFromEnv } from './tools/errands.js';
import { createLifecycle, serve, stopOnSignals } from './lifecycle.js';
import { createCognitoIdentity, type CognitoSend } from './accounts/identity.js';
import { createDynamoAccountStore, type DdbSend } from './accounts/store.js';
import { createBedrockConverse } from './assistant/bedrock.js';
import { BedrockAgentCoreClient, InvokeAgentRuntimeCommand } from '@aws-sdk/client-bedrock-agentcore';
import { agentCoreAssistant } from './assistant/runtime.js';
import { agentCoreForgetting, type MemorySend } from './assistant/forget.js';
import { invokedRingLinks } from './accounts/ringLinks.js';
import { createRekognitionModeration, type RekognitionSend } from './photos/moderation.js';
import { createS3PhotoObjects, type S3Send } from './photos/objects.js';
import { createTranscribeHearing, type TranscribeSend } from './hear/transcribe.js';

// Every read-tool file (get_resident_shared_view.ts, get_today.ts,
// did_visitor_come.ts, get_week_narrative.ts) defaults an unset TABLE_NAME to
// 'wick'. services/agent/src/egress.ts — a different, already-shipped module
// outside this server that send_note_to_tv.ts calls into via sendToDevice()
// — defaults it to '' instead (out of scope to change: it's shared with S1
// device wiring). Left unset, the two would silently disagree about which
// table to hit. Rather than change either module's own fallback, this
// entrypoint fails fast so the inconsistency can never happen at runtime.
const TABLE_NAME = process.env.TABLE_NAME;
if (!TABLE_NAME) {
  console.error('TABLE_NAME must be set. See .env / scripts/env.ts for local dev.');
  process.exit(1);
}

// People sign in against a Cognito user pool (infra/accounts.tf). There is
// no stand-in: a server that cannot tell who anyone is must not start.
const COGNITO_CLIENT_ID = process.env.WICK_COGNITO_CLIENT_ID;
if (!COGNITO_CLIENT_ID) {
  console.error('WICK_COGNITO_CLIENT_ID must be set: `terraform -chdir=infra output -raw cognito_client_id`.');
  process.exit(1);
}

// Where a television's six-digit code is confirmed (infra/pairing.tf).
const PAIRING_API_URL = process.env.WICK_PAIRING_API_URL?.replace(/\/+$/, '');
if (!PAIRING_API_URL) {
  console.error('WICK_PAIRING_API_URL must be set: `terraform -chdir=infra output -raw pairing_api_url`.');
  process.exit(1);
}

// One-click guest accounts (accounts/demo.ts). A deployment says yes; nothing else does.
const DEMO_ACCOUNTS = process.env.WICK_DEMO_ACCOUNTS === 'on';
const VIRTUAL_TELEVISION_URL = process.env.WICK_VIRTUAL_TV_URL || undefined;

// The model behind the family app's conversation (assistant/brain.ts), named
// by the deployment (infra/mcp.tf). Unset, there is no assistant: the route
// says so and the app answers by its rules — never a made-up reply.
const ASSISTANT_MODEL_ID = process.env.WICK_ASSISTANT_MODEL_ID || undefined;
const assistant = ASSISTANT_MODEL_ID
  ? {
      converse: createBedrockConverse(
        new BedrockRuntimeClient(process.env.WICK_ASSISTANT_REGION ? { region: process.env.WICK_ASSISTANT_REGION } : {}),
        ASSISTANT_MODEL_ID,
      ),
    }
  : undefined;

// The assistant as a Strands agent on AgentCore Runtime (assistant/turn.ts,
// infra/assistant.tf). Unset, POST /assistant/turn says 503 and the family app
// asks /assistant/next above. The member's own token travels in the payload;
// the instance role may only invoke this one runtime.
const ASSISTANT_RUNTIME_ARN = process.env.ASSISTANT_RUNTIME_ARN || undefined;
// Where the assistant keeps each member's conversation and own words: deleted with their account (assistant/forget.ts).
const AGENTCORE_MEMORY_ID = process.env.AGENTCORE_MEMORY_ID || undefined;
const agentCore = ASSISTANT_RUNTIME_ARN || AGENTCORE_MEMORY_ID ? new BedrockAgentCoreClient({}) : undefined;
const assistantAgent = ASSISTANT_RUNTIME_ARN && agentCore
  ? agentCoreAssistant({
      runtimeArn: ASSISTANT_RUNTIME_ARN,
      ...(process.env.ASSISTANT_RUNTIME_VERSION ? { version: process.env.ASSISTANT_RUNTIME_VERSION } : {}),
      send: (input, options) => agentCore.send(new InvokeAgentRuntimeCommand(input), options),
    })
  : undefined;
const assistantMemory = AGENTCORE_MEMORY_ID && agentCore
  ? agentCoreForgetting(((command) => agentCore.send(command as never)) as MemorySend, AGENTCORE_MEMORY_ID)
  : undefined;

// The mantelpiece (photos/send.ts): the bucket a picture is put in
// (infra names it), and Rekognition, which takes the one look at a picture
// before it is stored. Unset, the family app is told this Wick cannot send
// pictures: there is no sending without the check. This server only ever
// puts a picture there, and deletes one to undo a sending that failed — it
// is given no way to read one back.
const PHOTOS_BUCKET = process.env.PHOTOS_BUCKET || undefined;
const photos = PHOTOS_BUCKET
  ? (() => {
      const s3 = new S3Client({});
      const rekognition = new RekognitionClient(process.env.WICK_REKOGNITION_REGION ? { region: process.env.WICK_REKOGNITION_REGION } : {});
      return {
        objects: createS3PhotoObjects(((command) => s3.send(command as never)) as S3Send, PHOTOS_BUCKET),
        moderate: createRekognitionModeration(((command, options) => rekognition.send(command, options)) as RekognitionSend),
      };
    })()
  : undefined;

// Ask by voice (hear/transcribe.ts): Amazon Transcribe turns a family
// member's spoken question into words. No setting of its own: the client
// finds its region the way the DynamoDB client above does — the region App
// Runner runs the service in, which is the stack's (infra/mcp.tf) — and the
// instance role allows the one streaming call. Nothing it is sent is kept.
const transcribe = new TranscribeStreamingClient({});
const hear = createTranscribeHearing(((command, options) => transcribe.send(command, options)) as TranscribeSend);

// A home's own Ring link (accounts/apiRouter.ts `/api/ring`). The function
// named here has custody of the tokens; this server holds none and only says
// who is asking, for which home. Unset, the family app is told the doorbell
// cannot be reached.
const RING_LINK_FUNCTION = process.env.WICK_RING_LINK_FUNCTION || undefined;
const lambda = RING_LINK_FUNCTION ? new LambdaClient({}) : undefined;
const ringLinks = lambda
  ? invokedRingLinks(async (request) => {
      const reply = await lambda.send(new InvokeCommand({
        FunctionName: RING_LINK_FUNCTION,
        Payload: new TextEncoder().encode(JSON.stringify(request)),
      }));
      if (reply.FunctionError || !reply.Payload) return undefined;
      return JSON.parse(new TextDecoder().decode(reply.Payload)) as unknown;
    })
  : undefined;

// A demo home's stand-in doorbell (accounts/demoDoorbell.ts): one ring is
// handed to the Door agent's own Lambda, asynchronously — the card reaches
// her television from there, as a Ring doorbell's does. The function's name
// is fixed (infra/agent.tf, `${local.prefix}-agent-door-event`), so the
// deployment needs no new setting; only this server's role may invoke it.
const DEMO_DOOR_FUNCTION = process.env.WICK_DEMO_DOOR_FUNCTION || 'wick-agent-door-event';
const doorLambda = new LambdaClient({});
const ringDemoDoor = async (event: DemoDoorEvent): Promise<void> => {
  const reply = await doorLambda.send(new InvokeCommand({
    FunctionName: DEMO_DOOR_FUNCTION,
    InvocationType: 'Event',
    Payload: new TextEncoder().encode(JSON.stringify({ source: DEMO_DOOR_SOURCE, 'detail-type': DEMO_DOOR_DETAIL_TYPE, detail: event })),
  }));
  if (reply.StatusCode !== 202) throw new Error(`door agent answered ${reply.StatusCode ?? 'nothing'}`);
};

const PORT = Number(process.env.PORT ?? 3300);
const ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${PORT}`);

const ddb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient(
  process.env.WICK_COGNITO_REGION ? { region: process.env.WICK_COGNITO_REGION } : {},
);

// Told to stop (SIGTERM from App Runner, or Ctrl-C), the server finishes what it is answering first (lifecycle.ts).
const lifecycle = createLifecycle();
// The commit the image was built from (services/mcp-server/Dockerfile's WICK_COMMIT), for /health.
const COMMIT = process.env.WICK_COMMIT || undefined;

const app = createApp(ISSUER_URL, {
  lifecycle,
  about: { version: SERVER_VERSION, commit: COMMIT },
  store: createDynamoAccountStore(((command) => ddb.send(command as never)) as DdbSend, TABLE_NAME),
  identity: createCognitoIdentity(((command) => cognito.send(command as never)) as CognitoSend, COGNITO_CLIENT_ID),
  sendCard: (card, serverOnly) => sendToDevice(card, DEFAULT_POLICY, serverOnly),
  sendPatch: sendPatchToDevice,
  withdrawCard: (householdId, cardId) => takeBackFromDevices(cardId, householdId),
  sendHome: sendHomeToDevices,
  ddb,
  // `as` is 'family' for a television the signed-in person connects as their own, and absent for the resident's.
  // INV-8: the pairing API reads the household from that person's token; none is sent.
  claimTelevision: async (accessToken, code, as) => {
    const res = await fetch(`${PAIRING_API_URL}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ code, ...(as ? { as } : {}) }),
    });
    return { status: res.status, body: await res.text() };
  },
  demoAccounts: DEMO_ACCOUNTS,
  ringDemoDoor,
  // Visit errands (infra/errands.tf): the state machine named by ERRAND_STATE_MACHINE_ARN, or none.
  errands: errandMachineFromEnv(),
  ...(assistant ? { assistant } : {}),
  ...(assistantAgent ? { assistantAgent } : {}),
  ...(assistantMemory ? { assistantMemory } : {}),
  ...(ringLinks ? { ringLinks } : {}),
  ...(photos ? { photos } : {}),
  hear,
  ...(VIRTUAL_TELEVISION_URL ? { virtualTelevisionUrl: VIRTUAL_TELEVISION_URL } : {}),
});

const running = await serve(app, lifecycle, PORT);
stopOnSignals(running);
console.log(`Wick MCP server listening on ${ISSUER_URL.toString()}`);
console.log('MCP endpoint: POST /mcp');
console.log('Tunnel for Alexa+/MCP Inspector: cloudflared tunnel --url http://127.0.0.1:' + PORT);

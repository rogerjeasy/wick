/** Entrypoint: wires the real AWS clients into the server. Local dev and the App Runner container both run this. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { RekognitionClient } from '@aws-sdk/client-rekognition';
import { S3Client } from '@aws-sdk/client-s3';
import { TranscribeStreamingClient } from '@aws-sdk/client-transcribe-streaming';
import { DEFAULT_POLICY } from '@wick/policy';
import { sendHomeToDevices, sendPatchToDevice, sendToDevice, takeBackFromDevices } from '@wick/agent';
import { createApp } from './server.js';
import { createCognitoIdentity, type CognitoSend } from './accounts/identity.js';
import { createDynamoAccountStore, type DdbSend } from './accounts/store.js';
import { createBedrockConverse } from './assistant/bedrock.js';
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

const PORT = Number(process.env.PORT ?? 3300);
const ISSUER_URL = new URL(process.env.MCP_ISSUER_URL ?? `http://127.0.0.1:${PORT}`);

const ddb = new DynamoDBClient({});
const cognito = new CognitoIdentityProviderClient(
  process.env.WICK_COGNITO_REGION ? { region: process.env.WICK_COGNITO_REGION } : {},
);

const app = createApp(ISSUER_URL, {
  store: createDynamoAccountStore(((command) => ddb.send(command as never)) as DdbSend, TABLE_NAME),
  identity: createCognitoIdentity(((command) => cognito.send(command as never)) as CognitoSend, COGNITO_CLIENT_ID),
  sendCard: (card) => sendToDevice(card, DEFAULT_POLICY),
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
  ...(assistant ? { assistant } : {}),
  ...(ringLinks ? { ringLinks } : {}),
  ...(photos ? { photos } : {}),
  hear,
  ...(VIRTUAL_TELEVISION_URL ? { virtualTelevisionUrl: VIRTUAL_TELEVISION_URL } : {}),
});

app.listen(PORT, () => {
  console.log(`Wick MCP server listening on ${ISSUER_URL.toString()}`);
  console.log('MCP endpoint: POST /mcp');
  console.log('Tunnel for Alexa+/MCP Inspector: cloudflared tunnel --url http://127.0.0.1:' + PORT);
});

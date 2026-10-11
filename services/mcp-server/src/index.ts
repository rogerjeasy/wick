/** Entrypoint: wires the real AWS clients into the server. Local dev and the App Runner container both run this. */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { BedrockRuntimeClient } from '@aws-sdk/client-bedrock-runtime';
import { DEFAULT_POLICY } from '@wick/policy';
import { sendToDevice } from '@wick/agent';
import { createApp } from './server.js';
import { createCognitoIdentity, type CognitoSend } from './accounts/identity.js';
import { createDynamoAccountStore, type DdbSend } from './accounts/store.js';
import { createBedrockConverse } from './assistant/bedrock.js';

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
  ddb,
  claimTelevision: async (accessToken, code) => {
    const res = await fetch(`${PAIRING_API_URL}/pair/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ code }),
    });
    return { status: res.status, body: await res.text() };
  },
  demoAccounts: DEMO_ACCOUNTS,
  ...(assistant ? { assistant } : {}),
  ...(VIRTUAL_TELEVISION_URL ? { virtualTelevisionUrl: VIRTUAL_TELEVISION_URL } : {}),
});

app.listen(PORT, () => {
  console.log(`Wick MCP server listening on ${ISSUER_URL.toString()}`);
  console.log('MCP endpoint: POST /mcp');
  console.log('Tunnel for Alexa+/MCP Inspector: cloudflared tunnel --url http://127.0.0.1:' + PORT);
});

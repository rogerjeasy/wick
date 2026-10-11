/**
 * A household's Ring link, for the family app.
 *
 * Not on any public route. The Wick server invokes this function directly
 * (services/mcp-server/src/accounts/ringRouter.ts) after it has checked that
 * the person asking is the home's organiser, and it names the household from
 * their access token — so the `householdId` that arrives here was never
 * something a person typed (AGENTS.md INV-8). The function's own IAM policy
 * lets nobody else call it.
 *
 *   { action: 'status',     householdId }
 *   { action: 'start',      householdId, userId }          → { url }
 *   { action: 'complete',   householdId, userId, completion }
 *   { action: 'playground', householdId, userId, token }
 *   { action: 'disconnect', householdId }
 *
 * Answers `{ ok: true, … }` or `{ ok: false, error }`. Never a token.
 */
import { DynamoDBClient, DeleteItemCommand, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { beginAuthorization } from './authorization.mjs';
import { LinkError, createLinkService } from './household-link-service.mjs';
import { exchangeAuthorizationCode, listDevices } from './ring-api.mjs';
import { deleteTokens, finishLink, readCredentials, readTokens, writeTokens } from './ring-token.mjs';

const ddb = new DynamoDBClient({});
const COMMANDS = { get: GetItemCommand, put: PutItemCommand, delete: DeleteItemCommand };

export const linkService = createLinkService({
  table: process.env.TABLE_NAME,
  ddb: (command, input) => ddb.send(new COMMANDS[command](input)),
  // A link may bring a household's secret into being; nothing else may (ring-token.mjs).
  writeTokens: (householdId, record) => writeTokens(householdId, record, { create: true }),
  deleteTokens,
  listDevices,
  beginAuthorization,
  exchange: async ({ code, codeVerifier }) => {
    const { clientId, clientSecret } = await readCredentials();
    return exchangeAuthorizationCode({ code, codeVerifier, clientId, clientSecret, redirectUri: process.env.RING_REDIRECT_URI });
  },
  finishLink: async (householdId, tokens) => finishLink(householdId, tokens, { previous: await readTokens(householdId) }),
  // A pasted Playground token is a developer's tool: on only where the deployment says so.
  playgroundAllowed: process.env.RING_PLAYGROUND_LINK === 'true',
  now: Date.now,
});

export const handler = async (event) => {
  const { action, householdId, userId, token, completion } = event ?? {};
  try {
    if (action === 'status') return { ok: true, ...(await linkService.status(householdId)) };
    if (action === 'start') return { ok: true, ...(await linkService.start(householdId, userId)) };
    if (action === 'complete') return { ok: true, ...(await linkService.complete(householdId, userId, completion)) };
    if (action === 'playground') return { ok: true, ...(await linkService.playground(householdId, userId, token)) };
    if (action === 'disconnect') return { ok: true, ...(await linkService.disconnect(householdId)) };
    return { ok: false, error: 'unknown_action' };
  } catch (err) {
    if (err instanceof LinkError) return { ok: false, error: err.code };
    console.error(JSON.stringify({ level: 'error', msg: 'household_link_failed', action, householdId, err: err?.name ?? 'Error' }));
    return { ok: false, error: 'failed' };
  }
};

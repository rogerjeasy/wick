/**
 * Connecting a household to Ring, and disconnecting it.
 *
 * Who may ask is decided before this is reached: the family app's server
 * lets only a home's organiser through, and names the household from their
 * access token (services/mcp-server/src/accounts/ringRouter.ts, INV-8). What
 * is decided here is what a link is:
 *
 *   - the tokens go into that household's own secret, and nowhere else;
 *   - the doorbells that credential can see become that household's —
 *     unless another household already holds one, which is left alone;
 *   - a row beside the household says what is linked, with no token in it.
 *
 * Two ways in. Ring's own sign-in (`start`, finished by link.mjs when Ring
 * sends the browser back). And, where the deployment allows it, a token
 * pasted from Ring's Developer Playground — Ring's simulator, which is all
 * that can be shown without a doorbell (FRICTION.md FL-004, FL-019).
 *
 * Everything that touches AWS or Ring is passed in, so this is tested as
 * plain code (__tests__/household-link-service.test.ts).
 */
import {
  claimDevice, linkRow, linkSummary, playgroundRecord, readLinkRow, releaseDevice, removeLinkRow,
} from './household-links.mjs';
import { SAFE_HOUSEHOLD_ID } from './ring-token.mjs';

export class LinkError extends Error {
  constructor(code) {
    super(code);
    this.name = 'LinkError';
    this.code = code;
  }
}

/**
 * @param {object} deps
 * @param {string} deps.table
 * @param {(command: string, input: object) => Promise<any>} deps.ddb  'get' | 'put' | 'delete'
 * @param {(householdId: string, record: object) => Promise<object>} deps.writeTokens
 * @param {(householdId: string) => Promise<void>} deps.deleteTokens
 * @param {(args: { accessToken: string }) => Promise<{ id: string, name: string | null }[]>} deps.listDevices
 * @param {(args: { householdId: string, userId?: string }) => Promise<string>} deps.beginAuthorization
 * @param {boolean} deps.playgroundAllowed
 * @param {() => number} deps.now
 */
export function createLinkService(deps) {
  const { table } = deps;
  const safe = (householdId) => {
    if (typeof householdId !== 'string' || !SAFE_HOUSEHOLD_ID.test(householdId)) throw new LinkError('bad_household');
    return householdId;
  };

  const conditionFailed = (err) => err?.name === 'ConditionalCheckFailedException';

  async function status(householdId) {
    const row = await deps.ddb('get', readLinkRow({ table, householdId: safe(householdId) }));
    return { ...linkSummary(row?.Item, deps.now()), playgroundAllowed: deps.playgroundAllowed };
  }

  /**
   * The devices this credential can see become this household's, and the row
   * is written. Called once the tokens are safely in the household's secret.
   */
  async function recordLink(householdId, record, linkedBy) {
    const now = deps.now();
    let seen = [];
    try {
      seen = await deps.listDevices({ accessToken: record.access_token });
    } catch (err) {
      // The link holds; the list can be asked for again by linking again.
      console.warn(JSON.stringify({ level: 'warn', msg: 'ring_devices_not_listed', householdId, status: err?.status ?? null }));
    }

    const held = [];
    let heldElsewhere = 0;
    for (const device of seen) {
      try {
        await deps.ddb('put', claimDevice({ table, deviceId: device.id, householdId, now }));
        held.push(device);
      } catch (err) {
        if (!conditionFailed(err)) throw err;
        heldElsewhere += 1; // another home's doorbell stays that home's
      }
    }

    await deps.ddb('put', linkRow({ table, householdId, record, linkedBy, devices: held, heldElsewhere, now }));
    console.log(JSON.stringify({ level: 'info', msg: 'household_ring_linked', householdId, source: record.source ?? 'oauth', devices: held.length, heldElsewhere }));
    return status(householdId);
  }

  return {
    status,
    recordLink: (householdId, record, linkedBy) => recordLink(safe(householdId), record, linkedBy),

    /** Where to send the organiser's browser to sign in at Ring. */
    async start(householdId, userId) {
      return { url: await deps.beginAuthorization({ householdId: safe(householdId), userId }) };
    },

    /** Link with a token pasted from Ring's Developer Playground. Ring is asked first; a token it refuses is not kept. */
    async playground(householdId, userId, token) {
      safe(householdId);
      if (!deps.playgroundAllowed) throw new LinkError('playground_not_allowed');
      const pasted = typeof token === 'string' ? token.trim() : '';
      if (pasted.length < 20 || pasted.length > 8192 || /\s/.test(pasted)) throw new LinkError('bad_token');

      try {
        await deps.listDevices({ accessToken: pasted });
      } catch (err) {
        throw new LinkError(err?.status === 401 || err?.status === 403 ? 'token_refused' : 'ring_unreachable');
      }

      const record = playgroundRecord(pasted, deps.now());
      await deps.writeTokens(householdId, record);
      return recordLink(householdId, record, userId);
    },

    /** Let the doorbells go, remove the row, delete the secret. Safe to ask twice. */
    async disconnect(householdId) {
      safe(householdId);
      const row = await deps.ddb('get', readLinkRow({ table, householdId }));
      for (const device of linkSummary(row?.Item, deps.now()).devices ?? []) {
        try {
          await deps.ddb('delete', releaseDevice({ table, deviceId: device.id, householdId }));
        } catch (err) {
          if (!conditionFailed(err)) throw err; // no longer this household's to release
        }
      }
      await deps.deleteTokens(householdId);
      await deps.ddb('delete', removeLinkRow({ table, householdId }));
      console.log(JSON.stringify({ level: 'info', msg: 'household_ring_unlinked', householdId }));
      return status(householdId);
    },
  };
}

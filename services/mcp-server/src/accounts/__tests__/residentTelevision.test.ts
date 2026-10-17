/**
 * The resident stops Wick from her own television (residentTelevision.ts):
 * only her television's own token, only with the words "stop", and only
 * while that television is still connected.
 */
import { describe, expect, it, vi } from 'vitest';
import { createMemoryTable, type MemoryTable } from '../../__tests__/memoryTable.js';
import { createResidentTelevision } from '../residentTelevision.js';
import { AccountRefusal } from '../myData.js';
import { NOW, SARAHS_TV, STRANGER, bearer, putPublicKey, token } from './familyTvWorld.js';

const HER_TV = { deviceId: 'wick-tv', householdId: 'hh-1', proof: 'pairing' };
const CONFIRMED = { confirm: 'stop' };

function setUp(options: { connected?: boolean; denylisted?: boolean; closeHome?: (householdId: string) => Promise<void> } = {}) {
  const table: MemoryTable = createMemoryTable();
  putPublicKey(table);
  if (options.connected !== false) {
    table.put({ pk: { S: 'HH#hh-1' }, sk: { S: 'DEV#wick-tv' }, ...(options.denylisted ? { denylisted: { BOOL: true } } : {}) });
  }
  const closeHome = vi.fn(options.closeHome ?? (async () => undefined));
  const tv = createResidentTelevision({ ddb: table.ddb as never, now: () => NOW, closeHome });
  return { tv, closeHome };
}

describe('POST /tv/stop — she stops Wick from her own television', () => {
  it('closes her home when her own television asks, in words', async () => {
    const { tv, closeHome } = setUp();

    const reply = await tv.stop(bearer(token(HER_TV)), CONFIRMED);

    expect(reply).toEqual({ status: 200, body: { stopped: true } });
    expect(closeHome).toHaveBeenCalledWith('hh-1');
  });

  it.each([
    ['no body', undefined],
    ['an empty body', {}],
    ['any other word', { confirm: 'yes' }],
  ])('closes nothing without the word "stop": %s', async (_name, body) => {
    const { tv, closeHome } = setUp();

    expect((await tv.stop(bearer(token(HER_TV)), body)).status).toBe(400);
    expect(closeHome).not.toHaveBeenCalled();
  });

  it('refuses a family member’s television: it is hers alone to decide', async () => {
    const { tv, closeHome } = setUp();

    expect(await tv.stop(bearer(token(SARAHS_TV)), CONFIRMED)).toMatchObject({ status: 403 });
    expect(closeHome).not.toHaveBeenCalled();
  });

  it('refuses a background service’s narrow token', async () => {
    const { tv, closeHome } = setUp();

    expect((await tv.stop(bearer(token({ ...HER_TV, scope: 'waiting' })), CONFIRMED)).status).toBe(403);
    expect(closeHome).not.toHaveBeenCalled();
  });

  it('refuses a token earned by the television’s id alone: an id is a label, and this deletes a home', async () => {
    const { tv, closeHome } = setUp();

    expect(await tv.stop(bearer(token({ ...HER_TV, proof: 'none' })), CONFIRMED)).toMatchObject({ status: 403, body: { error: 'proof_required' } });
    // One from before the claim existed, an hour long: a refresh's, so unproven.
    const { proof: _proof, ...unclaimed } = HER_TV;
    expect((await tv.stop(bearer(token(unclaimed, { exp: Math.floor(NOW / 1000) + 3000 })), CONFIRMED)).status).toBe(403);
    expect(closeHome).not.toHaveBeenCalled();
  });

  it('takes a token earned by the television’s secret, and one from before the claim that lasted thirty days', async () => {
    expect((await setUp().tv.stop(bearer(token({ ...HER_TV, proof: 'secret' })), CONFIRMED)).status).toBe(200);
    const { proof: _proof, ...unclaimed } = HER_TV;
    expect((await setUp().tv.stop(bearer(token(unclaimed)), CONFIRMED)).status).toBe(200);
  });

  it('refuses a token the pairing key did not sign, and none at all', async () => {
    const { tv, closeHome } = setUp();

    expect((await tv.stop(bearer(token(HER_TV, { signedWith: STRANGER.privateKey })), CONFIRMED)).status).toBe(401);
    expect((await tv.stop(undefined, CONFIRMED)).status).toBe(401);
    expect(closeHome).not.toHaveBeenCalled();
  });

  it('refuses a television no longer connected, or revoked', async () => {
    for (const options of [{ connected: false }, { denylisted: true }]) {
      const { tv, closeHome } = setUp(options);
      expect((await tv.stop(bearer(token(HER_TV)), CONFIRMED)).status).toBe(401);
      expect(closeHome).not.toHaveBeenCalled();
    }
  });

  it('says so when the doorbell cannot be disconnected, and nothing is deleted', async () => {
    const { tv } = setUp({
      closeHome: async () => {
        throw new AccountRefusal(502, 'doorbell_unavailable', 'The doorbell could not be disconnected just now, so nothing was deleted. Try again in a moment.');
      },
    });

    expect(await tv.stop(bearer(token(HER_TV)), CONFIRMED)).toMatchObject({ status: 502, body: { error: 'doorbell_unavailable' } });
  });
});

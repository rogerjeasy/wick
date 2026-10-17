/**
 * She stops Wick, from her own television: the answer "Yes, delete
 * everything" on the last page of "What your family sees" (edge-device
 * sharing.mjs). The television asks the Wick server itself, with its own
 * device token (services/mcp-server accounts/residentTelevision.ts); the
 * server closes the home, and this television then shows a new code, as a
 * disconnected one does.
 *
 * Pure: given the fetch, the address and the token.
 */
import { SHARING_ACTIONS, type Card } from '@wick/contracts';

/** "Stopped": her home is closed. "Refused" and "failed": nothing was deleted, and the page stays for her to try again. */
export type Stopped = 'stopped' | 'refused' | 'failed';

/** Whether this press, on this card, is her "Yes, delete everything". */
export function stopsWick(card: Card, actionId: string): boolean {
  return card.type === 'SHARING' && actionId === SHARING_ACTIONS.stopYes;
}

export async function askToStop(fetchImpl: typeof fetch, serverUrl: string, jwt: string): Promise<Stopped> {
  try {
    const res = await fetchImpl(`${serverUrl}/tv/stop`, {
      method: 'POST',
      headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'stop' }),
    });
    return res.ok ? 'stopped' : 'refused';
  } catch {
    return 'failed';
  }
}

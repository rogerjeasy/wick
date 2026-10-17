import { describe, expect, it, vi } from 'vitest';
import type { Card } from '@wick/contracts';
import { askToStop, stopsWick } from '../stop.js';

const sharing = { type: 'SHARING', id: 'sharing' } as unknown as Card;

describe('she stops Wick from her own television', () => {
  it('is "Yes, delete everything" on the sharing card, and nothing else', () => {
    expect(stopsWick(sharing, 'stop_yes')).toBe(true);
    expect(stopsWick(sharing, 'stop')).toBe(false);
    expect(stopsWick(sharing, 'keep_wick')).toBe(false);
    expect(stopsWick({ type: 'MESSAGE' } as unknown as Card, 'stop_yes')).toBe(false);
  });

  it('asks the Wick server with the television’s own token, saying "stop" in words', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ stopped: true }), { status: 200 }));

    expect(await askToStop(fetchImpl as unknown as typeof fetch, 'https://wick.example', 'jwt-1')).toBe('stopped');
    expect(fetchImpl).toHaveBeenCalledWith('https://wick.example/tv/stop', {
      method: 'POST',
      headers: { authorization: 'Bearer jwt-1', 'content-type': 'application/json' },
      body: JSON.stringify({ confirm: 'stop' }),
    });
  });

  it('says it was refused, or could not be asked, so the page stays to try again', async () => {
    expect(await askToStop((async () => new Response('{}', { status: 502 })) as unknown as typeof fetch, 'https://w', 'j')).toBe('refused');
    expect(await askToStop((async () => { throw new TypeError('Network request failed'); }) as unknown as typeof fetch, 'https://w', 'j')).toBe('failed');
  });
});

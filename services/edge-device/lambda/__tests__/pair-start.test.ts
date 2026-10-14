import { describe, expect, it } from 'vitest';
import { PutItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-start.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { proofHashOf } from '../proof.mjs';

const NOW = 1_790_000_000_000;
const SECRET = 'n'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';
const OLD_SECRET = 'o'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';

function pairStart() {
  const written: Record<string, { S?: string; N?: string; BOOL?: boolean }>[] = [];
  const send = async (command: PutItemCommand) => {
    written.push(command.input.Item as (typeof written)[number]);
    return {};
  };
  const handler = createHandler({ send, now: () => NOW, table: 'wick', pairingUrlBase: 'https://wick.example', code: () => '123456' });
  return { written, ask: async (body: unknown) => (await handler({ body: JSON.stringify(body) })) as { statusCode: number; body: string } };
}

describe('POST /pair/start', () => {
  it('gives a code for a television, as always — one that sends no proof is paired without one', async () => {
    const { written, ask } = pairStart();

    const res = await ask({ deviceId: 'wick-tv' });

    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ code: '123456', url: 'https://wick.example/?pair=123456' });
    expect(written[0]).toMatchObject({ pk: { S: 'PAIR#123456' }, deviceId: { S: 'wick-tv' }, claimed: { BOOL: false } });
    expect(written[0]).not.toHaveProperty('proofHash');
  });

  // INV-1: the secret stays on the television. The nonce keeps its hash, for pair-claim.mjs to put on the television's row.
  it('keeps only the hash of the television’s secret, never the secret', async () => {
    const { written, ask } = pairStart();

    await ask({ deviceId: 'wick-abc', proof: SECRET });

    expect(written[0]!.proofHash).toEqual({ S: proofHashOf(SECRET) });
    expect(JSON.stringify(written)).not.toContain(SECRET);
  });

  it('keeps which television this one was, and only the hash of that one’s secret', async () => {
    const { written, ask } = pairStart();

    await ask({ deviceId: 'wick-new', proof: SECRET, replaces: { deviceId: 'wick-old', proof: OLD_SECRET } });

    expect(written[0]).toMatchObject({ replacesDeviceId: { S: 'wick-old' }, replacesProofHash: { S: proofHashOf(OLD_SECRET) } });
    expect(JSON.stringify(written)).not.toContain(OLD_SECRET);
  });

  it('refuses what is not an id, a secret or a television it was, and writes nothing', async () => {
    const { written, ask } = pairStart();
    const refused = [
      {},
      { deviceId: 'has spaces' },
      { deviceId: 'x'.repeat(65) },
      { deviceId: 42 },
      { deviceId: 'wick-abc', proof: 'short' },
      { deviceId: 'wick-abc', proof: SECRET, replaces: { deviceId: 'wick-old' } },
      { deviceId: 'wick-abc', proof: SECRET, replaces: { deviceId: 'wick-abc', proof: OLD_SECRET } },
      { deviceId: 'wick-abc', proof: SECRET, replaces: { deviceId: 'no good', proof: OLD_SECRET } },
    ];
    for (const body of refused) expect((await ask(body)).statusCode).toBe(400);
    expect(written).toEqual([]);
  });
});

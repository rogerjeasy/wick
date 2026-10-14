// INV-1: a television's id is not a secret — it was shown to family members,
// it was logged, and every Vega simulator's is `wick-tv`. So a television
// that keeps a secret (proof.mjs) is minted a token only for that secret, and
// one without a secret yet takes one only when it proves itself another way.
import { generateKeyPairSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { GetItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { createHandler } from '../pair-refresh.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { signJwt, verifyJwt } from '../jwt.mjs';
// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
import { proofHashOf } from '../proof.mjs';

const NOW = 1_790_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

type Item = Record<string, { S?: string; N?: string; BOOL?: boolean }>;

const SECRET = 'k'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';
const ANOTHER = 'z'.repeat(20) + '0123456789abcdef0123456789abcdef0123456789ab';

/**
 * One television's binding row, kept across calls, honouring the
 * conditions it is written under as DynamoDB would. `kind` says which row it
 * is: the resident's (DEV#) or a family member's own (FTV#).
 */
function television(kind: 'resident' | 'family', row: Item) {
  const sk = kind === 'resident' ? 'DEV#tv-1' : 'FTV#tv-1';
  let meanwhile: (() => void) | undefined;
  const send = async (command: { input: { Key: Item; UpdateExpression?: string; ConditionExpression?: string; ExpressionAttributeValues?: Item } }) => {
    const key = `${command.input.Key.pk!.S}|${command.input.Key.sk!.S}`;
    if (command instanceof GetItemCommand) {
      if (key === 'DEV#tv-1|META') return { Item: { householdId: { S: 'hh_1' } } };
      return { Item: key === `HH#hh_1|${sk}` ? { ...row } : undefined };
    }
    if (command instanceof UpdateItemCommand) {
      expect(key).toBe(`HH#hh_1|${sk}`);
      const other = meanwhile;
      meanwhile = undefined;
      other?.();
      const values = command.input.ExpressionAttributeValues ?? {};
      for (const clause of (command.input.ConditionExpression ?? '').split(' AND ').filter(Boolean)) {
        const missing = /^attribute_not_exists\((\w+)\)$/.exec(clause);
        const present = /^attribute_exists\((\w+)\)$/.exec(clause);
        const equal = /^(\w+) = (:\w+)$/.exec(clause);
        const greater = /^(\w+) > (:\w+)$/.exec(clause);
        const holds = missing
          ? row[missing[1]!] === undefined
          : present
            ? present[1] === 'pk' || row[present[1]!] !== undefined
            : equal
              ? JSON.stringify(row[equal[1]!]) === JSON.stringify(values[equal[2]!])
              : greater
                ? row[greater[1]!]?.N !== undefined && Number(row[greater[1]!]!.N) > Number(values[greater[2]!]!.N)
                : false;
        if (!holds) throw Object.assign(new Error(`condition failed: ${clause}`), { name: 'ConditionalCheckFailedException' });
      }
      const [, sets = '', removes = ''] = /^SET (.*?)(?: REMOVE (.*))?$/.exec(command.input.UpdateExpression ?? '') ?? [];
      for (const set of sets.split(', ').filter(Boolean)) {
        const [name, value] = set.split(' = ');
        row[name!] = values[value!]!;
      }
      for (const name of removes.split(', ').filter(Boolean)) delete row[name];
    }
    return {};
  };
  const handler = createHandler({ send, privateKey: async () => privateKey, publicKey: async () => publicKey, now: () => NOW, table: 'wick' });
  const ask = async (body: object, jwt?: string) => {
    const res = (await handler({
      body: JSON.stringify({ deviceId: 'tv-1', ...body }),
      headers: jwt ? { Authorization: `Bearer ${jwt}` } : {},
      requestContext: { http: { sourceIp: '203.0.113.7' } },
    })) as { statusCode: number; body: string };
    const token = res.statusCode === 200 ? (JSON.parse(res.body) as { token: { jwt: string } }).token : undefined;
    return { status: res.statusCode, body: res.body, claims: token ? (verifyJwt(token.jwt, publicKey) as Record<string, unknown>) : undefined };
  };
  return {
    row,
    ask,
    meanwhile: (what: () => void) => {
      meanwhile = what;
    },
  };
}

const residents = { deviceId: 'tv-1', householdId: 'hh_1' };
const token = (claims: object, expiresInSec: number) => signJwt({ ...residents, ...claims }, privateKey, { expiresInSec });
/** What a pairing hands a television: thirty days, earned by the code. */
const paired = (expiresInSec = 30 * 86400) => token({ proof: 'pairing' }, expiresInSec);

describe('POST /pair/refresh — a television that keeps a secret', () => {
  it('is minted a token only for its secret, and the token says so', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' }, proofHash: { S: proofHashOf(SECRET) } });

    const res = await tv.ask({ proof: SECRET });

    expect(res.status).toBe(200);
    expect(res.claims).toMatchObject({ ...residents, proof: 'secret' });
  });

  it('is minted nothing from its id alone, nor for another secret, nor for a token — and nothing is counted', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' }, proofHash: { S: proofHashOf(SECRET) } });

    for (const [body, jwt] of [[{}, undefined], [{ proof: ANOTHER }, undefined], [{ proof: 'short' }, undefined], [{}, paired()]] as const) {
      const res = await tv.ask(body, jwt);
      expect(res.status).toBe(401);
      expect(res.body).toBe('proof_required');
    }
    // A stranger who knows the id cannot use up the television's own share of refreshes.
    expect(tv.row).not.toHaveProperty('refreshCount');
    expect((await tv.ask({ proof: SECRET })).status).toBe(200);
  });

  it('is checked again in the write: a secret replaced between the read and the write is not answered with the old one', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' }, proofHash: { S: proofHashOf(SECRET) } });
    tv.meanwhile(() => {
      tv.row.proofHash = { S: proofHashOf(ANOTHER) };
    });

    expect((await tv.ask({ proof: SECRET })).status).toBe(401);
  });
});

describe('POST /pair/refresh — a television paired before secrets, or one that keeps nothing', () => {
  it('is still answered from its id alone — the exception — and that token says it proves nothing', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' } });

    const res = await tv.ask({});

    expect(res.status).toBe(200);
    expect(res.claims).toMatchObject({ ...residents, proof: 'none' });
    expect(tv.row).not.toHaveProperty('proofHash');
  });

  it('takes a secret shown with a token earned by pairing, and from then on is under the rule', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' } });

    const enrolled = await tv.ask({ proof: SECRET }, paired());
    expect(enrolled.status).toBe(200);
    expect(enrolled.claims).toMatchObject({ proof: 'secret' });
    expect(tv.row.proofHash).toEqual({ S: proofHashOf(SECRET) });
    expect(JSON.stringify(tv.row)).not.toContain(SECRET);

    expect((await tv.ask({})).body).toBe('proof_required');
    expect((await tv.ask({ proof: SECRET })).status).toBe(200);
  });

  it('takes one shown with a token a secret earned, and with a pairing’s token from before tokens said how', async () => {
    const proven = television('resident', { deviceId: { S: 'tv-1' } });
    expect((await proven.ask({ proof: SECRET }, token({ proof: 'secret' }, 3600))).claims).toMatchObject({ proof: 'secret' });
    expect(proven.row).toHaveProperty('proofHash');

    const older = television('resident', { deviceId: { S: 'tv-1' } });
    expect((await older.ask({ proof: SECRET }, token({}, 30 * 86400))).claims).toMatchObject({ proof: 'secret' });
    expect(older.row).toHaveProperty('proofHash');
  });

  // Whoever minted a token from the id alone must not be able to take the
  // television over, or lock it out, by enrolling a secret of their own.
  it('never takes a secret on the strength of a token minted without proof, one run out, another television’s or the family’s', async () => {
    const stranger = generateKeyPairSync('rsa', { modulusLength: 2048, publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' } });
    const refused = [
      undefined,
      token({ proof: 'none' }, 3600),
      // From before tokens said how: a refresh's hour proves nothing.
      token({}, 3600),
      paired(-60),
      signJwt({ deviceId: 'tv-2', householdId: 'hh_1', proof: 'pairing' }, privateKey, { expiresInSec: 600 }),
      signJwt({ ...residents, householdId: 'hh_2', proof: 'pairing' }, privateKey, { expiresInSec: 600 }),
      signJwt({ ...residents, kind: 'family', userId: 'u_sarah', proof: 'pairing' }, privateKey, { expiresInSec: 600 }),
      signJwt({ ...residents, proof: 'pairing' }, stranger.privateKey, { expiresInSec: 600 }),
    ];
    for (const jwt of refused) {
      const tv = television('resident', { deviceId: { S: 'tv-1' } });
      const res = await tv.ask({ proof: SECRET }, jwt);
      // Answered as before, under the exception — and nothing enrolled.
      expect(res.status).toBe(200);
      expect(res.claims).toMatchObject({ proof: 'none' });
      expect(tv.row).not.toHaveProperty('proofHash');
    }
  });

  it('enrols over nothing only: a secret enrolled meanwhile is not replaced, and the refresh is asked again under it', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' } });
    tv.meanwhile(() => {
      tv.row.proofHash = { S: proofHashOf(ANOTHER) };
    });

    const res = await tv.ask({ proof: SECRET }, paired());

    expect(res.status).toBe(401);
    expect(tv.row.proofHash).toEqual({ S: proofHashOf(ANOTHER) });
  });

  it('is not minted an unproven token once a secret has been enrolled between the read and the write', async () => {
    const tv = television('resident', { deviceId: { S: 'tv-1' } });
    tv.meanwhile(() => {
      tv.row.proofHash = { S: proofHashOf(SECRET) };
    });

    expect((await tv.ask({})).body).toBe('proof_required');
  });
});

describe('POST /pair/refresh — a family member’s own television that keeps a secret', () => {
  const sarahs = { ...residents, kind: 'family', userId: 'u_sarah' };
  const full = (expiresInSec = 3600) => signJwt(sarahs, privateKey, { expiresInSec });
  const row = (extra: Item = {}): Item => ({ deviceId: { S: 'tv-1' }, userId: { S: 'u_sarah' }, ...extra });

  it('needs its token and its secret: a token copied off the television, or found later, is no use alone', async () => {
    const tv = television('family', row({ proofHash: { S: proofHashOf(SECRET) } }));

    expect((await tv.ask({}, full(-3600))).body).toBe('proof_required');
    expect((await tv.ask({ proof: ANOTHER }, full())).body).toBe('proof_required');
    // And the secret without the token is nothing either.
    expect((await tv.ask({ proof: SECRET })).body).toBe('token_required');

    const res = await tv.ask({ proof: SECRET }, full(-3600));
    expect(res.status).toBe(200);
    expect(res.claims).toMatchObject({ ...sarahs, proof: 'secret' });
  });

  it('takes a secret shown with its own token that has not run out — never with one that has', async () => {
    const lapsed = television('family', row());
    expect((await lapsed.ask({ proof: SECRET }, full(-60))).status).toBe(200);
    expect(lapsed.row).not.toHaveProperty('proofHash');

    const current = television('family', row());
    expect((await current.ask({ proof: SECRET }, full())).status).toBe(200);
    expect(current.row.proofHash).toEqual({ S: proofHashOf(SECRET) });
  });

  // The second exception (AGENTS.md INV-1): the app opens the way with its
  // token and its secret, and its background service — which can be handed
  // nothing — takes its narrow token without either.
  it('still lets its service take the narrow token inside the way its app opened with both', async () => {
    const tv = television('family', row({ proofHash: { S: proofHashOf(SECRET) } }));

    expect((await tv.ask({ forService: true }, full())).body).toBe('proof_required');
    expect((await tv.ask({ forService: true, proof: SECRET }, full())).status).toBe(200);

    const service = await tv.ask({ forService: true });
    expect(service.status).toBe(200);
    expect(service.claims).toMatchObject({ scope: 'waiting' });
    expect(service.claims).not.toHaveProperty('proof');
  });
});

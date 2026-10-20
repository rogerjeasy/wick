/**
 * Allowances that hold for the whole deployment, not for one process.
 *
 * A model costs money and a guest account costs nothing (accounts/demo.ts),
 * so what an anonymous visitor may spend is bounded: the assistant's steps,
 * a spoken question's seconds of Transcribe, the guests a demo makes. Those
 * counters used to live in the server's memory. That was true only while one
 * instance served the deployment and nothing restarted, and App Runner
 * scales to 25 by default: every instance had its own allowance, and every
 * deploy gave a fresh one. So they are counted in the table, where every
 * instance reads the same number.
 *
 * A counter is one row, `LIMIT#<name>` / `W<window>#<index>`: a fixed window
 * of `windowMs`, counted with one conditional `ADD`. DynamoDB makes the
 * check and the count one step, so two instances racing for the last
 * allowance cannot both have it. Rows end with their window (the table's
 * `ttl`). Several allowances can stand in front of one thing (a person's,
 * everyone's, the day's): they are taken together or not at all. Taking is
 * one request each, in order, and an allowance taken before a later one
 * refuses is given back — by one more request that can itself fail, in which
 * case the counter stays over by that much until its window ends: a tighter
 * limit, never a looser one.
 *
 * When the table cannot be asked, nothing is allowed. These guard money; a
 * Wick whose table is down answers nothing else either.
 */
import { UpdateItemCommand, type DynamoDBClient } from '@aws-sdk/client-dynamodb';

/** One thing counted: the most it may be in a fixed window of `windowMs`. */
export interface Allowance {
  /** What is counted, and for whom: `assistant#guest#person#guest_ab12`. */
  readonly counter: string;
  readonly limit: number;
  readonly windowMs: number;
}

export interface Budget {
  /** True when every allowance has room for `cost` more now, and it is counted; false, and nothing counted, when any has not. */
  take(allowances: readonly Allowance[], cost?: number): Promise<boolean>;
}

const KEY_PREFIX = 'LIMIT#';

/** Which window of its kind a moment is in. */
const windowOf = (allowance: Allowance, now: number): number => Math.floor(now / allowance.windowMs);

/** When a counter's row may go: after its window, with a window to spare for clocks that disagree. */
const expiresAt = (allowance: Allowance, index: number): number => Math.ceil(((index + 2) * allowance.windowMs) / 1000);

const conditionFailed = (err: unknown): boolean => (err as { name?: string }).name === 'ConditionalCheckFailedException';

/** Counted in the table (infra/core.tf), by every instance of the server. */
export function dynamoBudget(ddb: DynamoDBClient, table: string, now: () => number): Budget {
  const key = (allowance: Allowance, index: number) => ({ pk: { S: `${KEY_PREFIX}${allowance.counter}` }, sk: { S: `W${allowance.windowMs}#${index}` } });

  const add = (allowance: Allowance, index: number, by: number, room: number | undefined): Promise<unknown> =>
    ddb.send(new UpdateItemCommand({
      TableName: table,
      Key: key(allowance, index),
      UpdateExpression: 'ADD #n :by SET #ttl = if_not_exists(#ttl, :ttl)',
      ...(room === undefined ? {} : { ConditionExpression: '(attribute_not_exists(#n) OR #n <= :room)' }),
      ExpressionAttributeNames: { '#n': 'n', '#ttl': 'ttl' },
      ExpressionAttributeValues: {
        ':by': { N: String(by) },
        ':ttl': { N: String(expiresAt(allowance, index)) },
        ...(room === undefined ? {} : { ':room': { N: String(room) } }),
      },
    }));

  return {
    async take(allowances, cost = 1) {
      const at = now();
      const taken: { allowance: Allowance; index: number }[] = [];
      for (const allowance of allowances) {
        const index = windowOf(allowance, at);
        // A cost bigger than the whole allowance can never be had.
        if (cost > allowance.limit) return giveBack(taken, cost);
        try {
          await add(allowance, index, cost, allowance.limit - cost);
          taken.push({ allowance, index });
        } catch (err) {
          await giveBack(taken, cost);
          if (conditionFailed(err)) return false;
          throw err;
        }
      }
      return true;
    },
  };

  async function giveBack(taken: readonly { allowance: Allowance; index: number }[], cost: number): Promise<false> {
    for (const { allowance, index } of taken) await add(allowance, index, -cost, undefined).catch(() => undefined);
    return false;
  }
}

/** The same rules, counted in this process: for the dev server and for tests of what is built on it. */
export function memoryBudget(now: () => number): Budget {
  const counts = new Map<string, number>();
  return {
    async take(allowances, cost = 1) {
      const at = now();
      const keys = allowances.map((a) => `${a.counter}|${a.windowMs}#${windowOf(a, at)}`);
      for (const [i, allowance] of allowances.entries()) {
        if ((counts.get(keys[i]!) ?? 0) + cost > allowance.limit) return false;
      }
      for (const k of keys) counts.set(k, (counts.get(k) ?? 0) + cost);
      return true;
    },
  };
}

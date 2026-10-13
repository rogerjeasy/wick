/**
 * Test-only: the photos bucket, in memory. It understands exactly the two
 * requests this server makes of it — PutObject (refusing to write over an
 * object that is there, as `IfNoneMatch: '*'` has S3 do) and DeleteObject —
 * records every request, and throws on anything else: a read of an object,
 * its existence or its tags is a request this server must never make
 * (packages/contracts mantel.ts, THE RULE).
 */
import type { S3Send } from '../objects.js';

export interface StoredObject {
  readonly bytes: Uint8Array;
  readonly contentType: string | undefined;
  readonly tagging: string | undefined;
}

export interface MemoryObjects {
  readonly send: S3Send;
  /** Every request made, in order: the command's name and its input. */
  readonly sent: { readonly name: string; readonly input: Record<string, unknown> }[];
  /** What is in the bucket, by key. */
  readonly objects: Map<string, StoredObject>;
  /** The next requests fail, as S3 unreachable would. */
  failing: boolean;
}

export function createMemoryObjects(): MemoryObjects {
  const objects = new Map<string, StoredObject>();
  const sent: MemoryObjects['sent'] = [];
  const state = { failing: false };
  const send = (async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
    const { input } = command;
    const name = command.constructor.name;
    sent.push({ name, input });
    if (state.failing) throw Object.assign(new Error('bucket unreachable'), { name: 'ServiceUnavailable' });
    const key = String(input.Key);
    if (name === 'PutObjectCommand') {
      if (input.IfNoneMatch === '*' && objects.has(key)) throw Object.assign(new Error('At least one of the pre-conditions you specified did not hold'), { name: 'PreconditionFailed' });
      objects.set(key, { bytes: input.Body as Uint8Array, contentType: input.ContentType as string | undefined, tagging: input.Tagging as string | undefined });
      return {};
    }
    if (name === 'DeleteObjectCommand') {
      objects.delete(key);
      return {};
    }
    throw new Error(`memoryObjects: unsupported request ${name}`);
  }) as unknown as S3Send;

  return {
    send,
    sent,
    objects,
    get failing() {
      return state.failing;
    },
    set failing(value: boolean) {
      state.failing = value;
    },
  };
}

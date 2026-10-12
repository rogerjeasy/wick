import { describe, expect, it, vi } from 'vitest';
import { nudge, subscriptionFromItem, type NudgeDeps, type StoredSubscription } from '../nudge.js';

const sub = (id: string, endpoint = `https://fcm.googleapis.com/fcm/send/${id}`): StoredSubscription => ({
  sk: `PUSH#${id}`,
  endpoint,
  p256dh: 'BPublicKey',
  auth: 'authSecret',
});

function deps(over: Partial<NudgeDeps> = {}): NudgeDeps {
  return {
    listSubscriptions: vi.fn(async (userId: string) => (userId === 'u-sarah' ? [sub('laptop'), sub('phone')] : [])),
    post: vi.fn(async () => 201),
    forget: vi.fn(async () => {}),
    ...over,
  };
}

describe('nudge — telling a family member’s own browsers there is something to open', () => {
  it('sends the kind, and nothing else, to every browser of every person asked', async () => {
    const d = deps();

    const outcome = await nudge(['u-sarah', 'u-tom'], 'door_look', d);

    expect(vi.mocked(d.post).mock.calls).toEqual([
      [sub('laptop'), '{"kind":"door_look"}'],
      [sub('phone'), '{"kind":"door_look"}'],
    ]);
    expect(outcome).toEqual({ sent: 2, gone: 0, failed: 0 });
  });

  it('forgets a browser the push service says is gone', async () => {
    const d = deps({ post: vi.fn(async (s: StoredSubscription) => (s.sk === 'PUSH#phone' ? 410 : 201)) });

    expect(await nudge(['u-sarah'], 'door_look', d)).toEqual({ sent: 1, gone: 1, failed: 0 });
    expect(d.forget).toHaveBeenCalledTimes(1);
    expect(d.forget).toHaveBeenCalledWith('u-sarah', 'PUSH#phone');
  });

  it('keeps a browser the push service merely refused this once', async () => {
    const d = deps({ post: vi.fn(async () => 429) });

    expect(await nudge(['u-sarah'], 'door_look', d)).toEqual({ sent: 0, gone: 0, failed: 2 });
    expect(d.forget).not.toHaveBeenCalled();
  });

  it('never calls an address that is not a push service, whatever a row says', async () => {
    const d = deps({ listSubscriptions: vi.fn(async () => [sub('bad', 'https://169.254.169.254/latest/meta-data/'), sub('good')]) });

    const outcome = await nudge(['u-sarah'], 'door_look', d);

    expect(vi.mocked(d.post).mock.calls.map(([s]) => s.sk)).toEqual(['PUSH#good']);
    expect(outcome).toEqual({ sent: 1, gone: 0, failed: 1 });
  });

  it('never throws: one browser that cannot be reached must not cost the others, or the card', async () => {
    const d = deps({
      listSubscriptions: vi.fn(async (userId: string) => {
        if (userId === 'u-tom') throw new Error('table down');
        return [sub('laptop'), sub('phone')];
      }),
      post: vi.fn(async (s: StoredSubscription) => {
        if (s.sk === 'PUSH#laptop') throw new Error('network');
        return 201;
      }),
    });

    expect(await nudge(['u-tom', 'u-sarah'], 'door_look', d)).toEqual({ sent: 1, gone: 0, failed: 2 });
  });

  it('asks each person once, however often they are named', async () => {
    const d = deps();

    await nudge(['u-sarah', 'u-sarah'], 'door_look', d);

    expect(d.listSubscriptions).toHaveBeenCalledTimes(1);
  });
});

describe('subscriptionFromItem', () => {
  it('reads a stored browser', () => {
    expect(subscriptionFromItem({
      pk: { S: 'USER#u-sarah' },
      sk: { S: 'PUSH#abc' },
      endpoint: { S: 'https://fcm.googleapis.com/fcm/send/abc' },
      p256dh: { S: 'BKey' },
      auth: { S: 'secret' },
    })).toEqual({ sk: 'PUSH#abc', endpoint: 'https://fcm.googleapis.com/fcm/send/abc', p256dh: 'BKey', auth: 'secret' });
  });

  it('is undefined for a row that is missing a part', () => {
    expect(subscriptionFromItem({ sk: { S: 'PUSH#abc' }, endpoint: { S: 'https://fcm.googleapis.com/x' } })).toBeUndefined();
  });
});

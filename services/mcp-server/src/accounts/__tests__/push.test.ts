import { describe, expect, it } from 'vitest';
import { createMemoryTable } from '../../__tests__/memoryTable.js';
import { MAX_BROWSERS_PER_PERSON, createPushStore, parseSubscription, pushSubscriptionSk } from '../push.js';

const P256DH = 'B'.repeat(87);
const AUTH = 'a'.repeat(22);
const browser = (id: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${id}`, keys: { p256dh: P256DH, auth: AUTH } });

describe('parseSubscription — what a browser may register', () => {
  it('accepts what PushSubscription.toJSON() gives', () => {
    expect(parseSubscription({ ...browser('abc'), expirationTime: null })).toEqual({
      endpoint: 'https://fcm.googleapis.com/fcm/send/abc',
      p256dh: P256DH,
      auth: AUTH,
    });
  });

  it('refuses an address that is not a browser push service', () => {
    expect(parseSubscription({ ...browser('abc'), endpoint: 'https://internal.example/hook' })).toBeUndefined();
    expect(parseSubscription({ ...browser('abc'), endpoint: 'http://fcm.googleapis.com/fcm/send/abc' })).toBeUndefined();
  });

  it('refuses keys that are not the two short base64url strings a browser sends', () => {
    expect(parseSubscription({ ...browser('abc'), keys: { p256dh: 'not base64 !!', auth: AUTH } })).toBeUndefined();
    expect(parseSubscription({ ...browser('abc'), keys: { p256dh: P256DH, auth: 'x'.repeat(500) } })).toBeUndefined();
    expect(parseSubscription({ endpoint: browser('abc').endpoint })).toBeUndefined();
  });

  it('refuses an address too long to be one, and anything that is not an object', () => {
    expect(parseSubscription({ ...browser('a'.repeat(3000)) })).toBeUndefined();
    expect(parseSubscription('https://fcm.googleapis.com/fcm/send/abc')).toBeUndefined();
    expect(parseSubscription(null)).toBeUndefined();
  });
});

describe('pushSubscriptionSk', () => {
  it('is short, stable, and never the address itself', () => {
    const { endpoint } = browser('abc123');

    expect(pushSubscriptionSk(endpoint)).toBe(pushSubscriptionSk(endpoint));
    expect(pushSubscriptionSk(endpoint)).toMatch(/^PUSH#[A-Za-z0-9_-]{22}$/);
    expect(pushSubscriptionSk(endpoint)).not.toBe(pushSubscriptionSk(`${endpoint}4`));
  });
});

describe('createPushStore', () => {
  const parsed = (id: string) => parseSubscription(browser(id))!;

  it('has no public key until the deployment has been given its push keys', async () => {
    expect(await createPushStore(createMemoryTable().ddb, 'wick').publicKey()).toBeUndefined();
  });

  it('reads the public key the bootstrap wrote', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: 'CONFIG#push' }, sk: { S: 'VAPID' }, publicKey: { S: 'BPublicVapidKey' } });

    expect(await createPushStore(table.ddb, 'wick').publicKey()).toBe('BPublicVapidKey');
  });

  it('keeps one row per browser under the person, as the agent plane reads it', async () => {
    const table = createMemoryTable();
    const store = createPushStore(table.ddb, 'wick');

    await store.save('u-sarah', parsed('laptop'), 1000);
    await store.save('u-sarah', parsed('laptop'), 2000);

    expect(table.rows('USER#u-sarah')).toEqual([{
      pk: { S: 'USER#u-sarah' },
      sk: { S: pushSubscriptionSk(browser('laptop').endpoint) },
      endpoint: { S: browser('laptop').endpoint },
      p256dh: { S: P256DH },
      auth: { S: AUTH },
      savedAt: { N: '2000' },
    }]);
  });

  it('forgets a browser when asked, and only that one', async () => {
    const table = createMemoryTable();
    const store = createPushStore(table.ddb, 'wick');
    await store.save('u-sarah', parsed('laptop'), 1000);
    await store.save('u-sarah', parsed('phone'), 1001);

    await store.remove('u-sarah', browser('laptop').endpoint);

    expect(table.rows('USER#u-sarah').map((row) => row.endpoint?.S)).toEqual([browser('phone').endpoint]);
  });

  it('keeps only a person’s few newest browsers, so one press never fans out without bound', async () => {
    const table = createMemoryTable();
    const store = createPushStore(table.ddb, 'wick');
    for (let i = 0; i < MAX_BROWSERS_PER_PERSON + 2; i += 1) await store.save('u-sarah', parsed(`b${i}`), 1000 + i);

    const kept = table.rows('USER#u-sarah').map((row) => row.endpoint?.S);

    expect(kept).toHaveLength(MAX_BROWSERS_PER_PERSON);
    expect(kept).not.toContain(browser('b0').endpoint);
    expect(kept).not.toContain(browser('b1').endpoint);
    expect(kept).toContain(browser(`b${MAX_BROWSERS_PER_PERSON + 1}`).endpoint);
  });

  it('leaves the person’s other rows alone', async () => {
    const table = createMemoryTable();
    table.put({ pk: { S: 'USER#u-sarah' }, sk: { S: 'PROFILE' }, name: { S: 'Sarah' } });
    const store = createPushStore(table.ddb, 'wick');
    for (let i = 0; i < MAX_BROWSERS_PER_PERSON + 1; i += 1) await store.save('u-sarah', parsed(`b${i}`), 1000 + i);

    expect(table.rows('USER#u-sarah').some((row) => row.sk?.S === 'PROFILE')).toBe(true);
  });
});

import { describe, expect, it } from 'vitest';
import {
  DENIED,
  REAUTHORISE_S,
  SAFE_DEVICE_ID,
  allowed,
  devicePolicy,
  mqttConnectionId,
  placeOf,
  presenceConnected,
  presenceDisconnected,
  sessionSeconds,
  tokenFrom,
  topicsOf,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../iot-policy.mjs';

const PLACE = { region: 'us-east-1', accountId: '111122223333' };
const TV = '0b9f6a4e-3c1d-4f7a-9a55-2f0e8d1c7b3a';
const OTHER = '7d2c1e90-aaaa-4bbb-8ccc-1234567890ab';

interface Statement {
  Effect: string;
  Action: string;
  Resource: string | string[];
}
const resources = (policy: { Statement: Statement[] }, action: string): string[] =>
  policy.Statement.filter((s) => s.Action === action).flatMap((s) => (Array.isArray(s.Resource) ? s.Resource : [s.Resource]));

describe('tokenFrom', () => {
  it('reads the token from the address a WebSocket was opened with', () => {
    const event = { protocolData: { http: { queryString: '?x-amz-customauthorizer-name=wick-device&token=aaa.bbb.ccc' } } };

    expect(tokenFrom(event)).toBe('aaa.bbb.ccc');
  });

  it('reads it without the leading question mark too', () => {
    expect(tokenFrom({ protocolData: { http: { queryString: 'token=aaa.bbb.ccc' } } })).toBe('aaa.bbb.ccc');
  });

  it('reads it from the MQTT password, which IoT Core hands over base64-encoded', () => {
    const event = { protocolData: { mqtt: { username: TV, password: Buffer.from('aaa.bbb.ccc').toString('base64') } } };

    expect(tokenFrom(event)).toBe('aaa.bbb.ccc');
  });

  it('has nothing for a connection that sent none', () => {
    expect(tokenFrom({ protocolData: { http: { queryString: '?x-amz-customauthorizer-name=wick-device' } } })).toBeUndefined();
    expect(tokenFrom({})).toBeUndefined();
    expect(tokenFrom(undefined)).toBeUndefined();
  });
});

describe('devicePolicy', () => {
  const policy = devicePolicy({ ...PLACE, deviceId: TV });

  it('lets a television connect under its own id only', () => {
    expect(resources(policy, 'iot:Connect')).toEqual([`arn:aws:iot:us-east-1:111122223333:client/${TV}`]);
  });

  it('lets it hear its own cards and control messages, and send its own events', () => {
    expect(resources(policy, 'iot:Subscribe')).toEqual([
      `arn:aws:iot:us-east-1:111122223333:topicfilter/wick/device/${TV}/cards`,
      `arn:aws:iot:us-east-1:111122223333:topicfilter/wick/device/${TV}/control`,
    ]);
    expect(resources(policy, 'iot:Receive')).toEqual([
      `arn:aws:iot:us-east-1:111122223333:topic/wick/device/${TV}/cards`,
      `arn:aws:iot:us-east-1:111122223333:topic/wick/device/${TV}/control`,
    ]);
    expect(resources(policy, 'iot:Publish')).toEqual([`arn:aws:iot:us-east-1:111122223333:topic/wick/device/${TV}/events`]);
  });

  it('names no other television, no wildcard, and nothing it may not do', () => {
    const everything = JSON.stringify(policy);

    expect(everything).not.toContain(OTHER);
    expect(everything).not.toMatch(/[*?#+]/);
    expect(policy.Statement.every((s: Statement) => s.Effect === 'Allow')).toBe(true);
    expect(policy.Statement.map((s: Statement) => s.Action).sort()).toEqual(['iot:Connect', 'iot:Publish', 'iot:Receive', 'iot:Subscribe']);
  });

  it('cannot publish cards to itself, nor read its own events back', () => {
    expect(resources(policy, 'iot:Publish').some((r) => r.endsWith('/cards') || r.endsWith('/control'))).toBe(false);
    expect(resources(policy, 'iot:Subscribe').some((r) => r.endsWith('/events'))).toBe(false);
  });

  it('refuses an id that would widen the policy: a wildcard, a topic level, or nothing', () => {
    for (const id of ['*', 'tv/+', `${TV}/../${OTHER}`, 'wick tv', '', 'a'.repeat(65), 'tv#', 'tv?']) {
      expect(SAFE_DEVICE_ID.test(id), id).toBe(false);
      expect(() => devicePolicy({ ...PLACE, deviceId: id }), id).toThrow('unsafe_device_id');
    }
  });

  it('accepts the ids Wick issues', () => {
    expect(SAFE_DEVICE_ID.test(TV)).toBe(true);
    expect(SAFE_DEVICE_ID.test('wick-tv')).toBe(true);
  });
});

describe('sessionSeconds', () => {
  it('ends the connection when the token ends', () => {
    expect(sessionSeconds({ exp: 10_000 + 3_600, nowS: 10_000 })).toBe(3_600);
  });

  it('keeps within IoT Core\'s bounds: five minutes at least, a day at most', () => {
    expect(sessionSeconds({ exp: 10_000 + 20, nowS: 10_000 })).toBe(300);
    expect(sessionSeconds({ exp: 10_000 + 30 * 86_400, nowS: 10_000 })).toBe(86_400);
  });
});

describe('allowed and DENIED', () => {
  it('answers a good token with that television\'s policy, and asks again every five minutes', () => {
    const answer = allowed({ ...PLACE, deviceId: 'wick-tv', exp: 10_000 + 7_200, nowS: 10_000 });

    expect(answer).toMatchObject({ isAuthenticated: true, principalId: 'wicktv', disconnectAfterInSeconds: 7_200, refreshAfterInSeconds: REAUTHORISE_S });
    expect(answer.policyDocuments).toEqual([devicePolicy({ ...PLACE, deviceId: 'wick-tv' })]);
    expect(answer.principalId).toMatch(/^[A-Za-z0-9]{1,128}$/);
  });

  it('refuses with no policy at all', () => {
    expect(DENIED).toMatchObject({ isAuthenticated: false, policyDocuments: [] });
  });
});

describe('placeOf', () => {
  it('reads the region and account from the running Lambda\'s own ARN', () => {
    expect(placeOf('arn:aws:lambda:us-east-1:111122223333:function:wick-iot-authorize')).toEqual(PLACE);
  });
});

describe('presence', () => {
  const at = 1_760_000_000_000;

  it('records a television on MQTT under its session, and refuses one that is revoked or unknown', () => {
    const update = presenceConnected({ table: 'wick', householdId: 'hh_1', deviceId: TV, sessionIdentifier: 'sess-1', at });

    expect(update.Key).toEqual({ pk: { S: 'HH#hh_1' }, sk: { S: `DEV#${TV}` } });
    expect(update.UpdateExpression).toBe('SET connectionId = :c, transport = :t, connectedAt = :ca REMOVE wsEndpoint');
    expect(update.ExpressionAttributeValues).toMatchObject({ ':c': { S: 'mqtt:sess-1' }, ':t': { S: 'mqtt' }, ':ca': { N: String(at) } });
    expect(update.ConditionExpression).toContain('attribute_exists(pk)');
    expect(update.ConditionExpression).toContain('denylisted');
  });

  it('clears the row on disconnect only while it still names that session', () => {
    const update = presenceDisconnected({ table: 'wick', householdId: 'hh_1', deviceId: TV, sessionIdentifier: 'sess-1' });

    expect(update.ConditionExpression).toBe('connectionId = :cid');
    expect(update.ExpressionAttributeValues).toEqual({ ':cid': { S: mqttConnectionId('sess-1') } });
    expect(update.UpdateExpression).toBe('REMOVE connectionId, transport, wsEndpoint, connectedAt');
  });

  it('never mistakes a WebSocket connection id for an MQTT session', () => {
    expect(mqttConnectionId('abc')).not.toBe('abc');
  });
});

describe('topicsOf', () => {
  it('is the three topics the television\'s MQTT client uses', () => {
    expect(topicsOf('wick-tv')).toEqual({
      cards: 'wick/device/wick-tv/cards',
      control: 'wick/device/wick-tv/control',
      events: 'wick/device/wick-tv/events',
    });
  });
});

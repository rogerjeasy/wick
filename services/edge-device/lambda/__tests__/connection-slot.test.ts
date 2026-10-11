import { describe, expect, it } from 'vitest';
import {
  BACKGROUND_SLOT,
  clearExpressions,
  FOREGROUND_SLOT,
  setExpression,
  slotForRole,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../connection-slot.mjs';

describe('slotForRole', () => {
  it('is the background slot only for an exact role=background', () => {
    expect(slotForRole('background')).toBe(BACKGROUND_SLOT);
  });

  it('is the foreground slot for a television that sends no role — every one paired before this existed', () => {
    expect(slotForRole(undefined)).toBe(FOREGROUND_SLOT);
  });

  it('is the foreground slot for anything it does not recognise', () => {
    expect(slotForRole('Background')).toBe(FOREGROUND_SLOT);
    expect(slotForRole('')).toBe(FOREGROUND_SLOT);
  });
});

describe('the two slots', () => {
  it('share no attribute, so one connecting or dropping never disturbs the other', () => {
    const shared = FOREGROUND_SLOT.attributes.filter((a: string) => BACKGROUND_SLOT.attributes.includes(a));
    expect(shared).toEqual([]);
  });

  it('keep the foreground attributes every existing reader already uses', () => {
    expect(setExpression(FOREGROUND_SLOT)).toBe('SET connectionId = :c, transport = :t, wsEndpoint = :w, connectedAt = :ca');
    expect(clearExpressions(FOREGROUND_SLOT)).toEqual({
      UpdateExpression: 'REMOVE connectionId, transport, wsEndpoint, connectedAt',
      ConditionExpression: 'connectionId = :cid',
    });
  });

  it('clear the background connection only if it is still this one', () => {
    expect(clearExpressions(BACKGROUND_SLOT)).toEqual({
      UpdateExpression: 'REMOVE bgConnectionId, bgTransport, bgWsEndpoint, bgConnectedAt',
      ConditionExpression: 'bgConnectionId = :cid',
    });
  });
});

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  ASSISTANT_AGENT_ID,
  assistantSessionId,
  memberMemory,
  memberNamespace,
  MEMBER_NAMESPACE_TEMPLATE,
} from '../identity.js';

describe('assistantSessionId — one conversation per member of a home', () => {
  it('is "assistant-" and the first 32 hex of sha256(householdId:memberId)', () => {
    const expected = createHash('sha256').update('hh_abc:usr-1').digest('hex').slice(0, 32);

    expect(assistantSessionId('hh_abc', 'usr-1')).toBe(`assistant-${expected}`);
  });

  it('is long enough for an AgentCore runtime session (33 characters at least)', () => {
    expect(assistantSessionId('h', 'm').length).toBeGreaterThanOrEqual(33);
  });

  it('is a valid Strands session id and a valid AgentCore Memory session id', () => {
    const id = assistantSessionId('hh_Zz-9', 'guest_Q_x');

    expect(id).toMatch(/^[a-z0-9_-]+$/);
    expect(id).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9-_]*$/);
  });

  it('is the same member in the same home every time, and someone else anywhere else', () => {
    expect(assistantSessionId('hh_a', 'u1')).toBe(assistantSessionId('hh_a', 'u1'));
    expect(assistantSessionId('hh_a', 'u1')).not.toBe(assistantSessionId('hh_a', 'u2'));
    expect(assistantSessionId('hh_a', 'u1')).not.toBe(assistantSessionId('hh_b', 'u1'));
  });

  it('refuses an id with the separator in it, so two members can never share one by moving it', () => {
    expect(() => assistantSessionId('hh_a:b', 'c')).toThrow();
    expect(() => assistantSessionId('hh_a', 'b:c')).toThrow();
    expect(() => assistantSessionId('', 'c')).toThrow();
  });
});

describe('memberMemory — where a member’s own words are remembered, in one home', () => {
  it('names the member as the actor and the home as the session, under /households/{home}/members/{member}', () => {
    expect(memberMemory('hh_abc', 'usr-1')).toEqual({
      actorId: 'usr-1',
      sessionId: 'hh_abc',
      namespace: '/households/hh_abc/members/usr-1',
    });
    expect(memberNamespace('hh_abc', 'usr-1')).toBe('/households/hh_abc/members/usr-1');
  });

  it('is the namespace the memory strategy writes to: its template, with the home as {sessionId}', () => {
    expect(MEMBER_NAMESPACE_TEMPLATE).toBe('/households/{sessionId}/members/{actorId}');
    expect(MEMBER_NAMESPACE_TEMPLATE.replace('{sessionId}', 'hh_abc').replace('{actorId}', 'usr-1')).toBe(memberNamespace('hh_abc', 'usr-1'));
  });

  it('has no place for an id AgentCore would refuse, so nothing is remembered under one', () => {
    expect(memberMemory('hh_abc', '-starts-with-a-dash')).toBeUndefined();
    expect(memberMemory('hh a', 'usr-1')).toBeUndefined();
    expect(memberMemory('', 'usr-1')).toBeUndefined();
    expect(memberMemory('hh_abc', 'x'.repeat(101))).toBeUndefined();
  });

  it('keeps the conversation’s saved state apart from the member’s words: another actor', () => {
    expect(ASSISTANT_AGENT_ID).toBe('wick-assistant');
    expect(memberMemory('hh_abc', ASSISTANT_AGENT_ID)?.actorId).not.toBe('usr-1');
  });
});

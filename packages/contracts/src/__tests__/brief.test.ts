import { describe, expect, it } from 'vitest';
import { BRIEF_REASON_MAX_CHARS, SUGGESTED_ACTIONS, readBriefSuggestion } from '../brief.js';
import { PUSH_KINDS, isPushKind } from '../push.js';

describe('the brief’s one suggestion', () => {
  it('is one of four actions, and nothing else', () => {
    expect(SUGGESTED_ACTIONS).toEqual(['send_note', 'arrange_visit', 'watch_together', 'nothing']);
  });

  it('reads a suggestion with a short reason', () => {
    expect(readBriefSuggestion({ action: 'send_note', reason: 'She watched less on Wednesday than usual.' })).toEqual({
      action: 'send_note',
      reason: 'She watched less on Wednesday than usual.',
    });
  });

  it('trims the reason and refuses an empty, overlong or unknown one', () => {
    expect(readBriefSuggestion({ action: 'nothing', reason: '  A quiet, usual week.  ' })?.reason).toBe('A quiet, usual week.');
    for (const bad of [
      null,
      {},
      { action: 'call_her', reason: 'x' },
      { action: 'send_note', reason: '' },
      { action: 'send_note', reason: '   ' },
      { action: 'send_note', reason: 'x'.repeat(BRIEF_REASON_MAX_CHARS + 1) },
      { action: 'send_note' },
    ]) {
      expect(readBriefSuggestion(bad), JSON.stringify(bad)).toBeUndefined();
    }
  });
});

describe('the pushes errands and the brief send', () => {
  it('are known kinds', () => {
    expect(PUSH_KINDS.errandRang).toBe('errand_rang');
    expect(PUSH_KINDS.errandNoShow).toBe('errand_no_show');
    expect(PUSH_KINDS.weekReady).toBe('week_ready');
    for (const kind of ['errand_rang', 'errand_no_show', 'week_ready']) expect(isPushKind(kind)).toBe(true);
  });
});

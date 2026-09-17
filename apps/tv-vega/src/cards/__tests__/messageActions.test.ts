import { describe, it, expect } from 'vitest';
import { replyActions } from '../messageActions.js';

describe('replyActions', () => {
  it('turns each suggested reply into its own button', () => {
    const actions = replyActions(['Thanks!', "I'll call you soon.", 'Not right now.']);
    expect(actions.map((a) => a.label)).toEqual(['Thanks!', "I'll call you soon.", 'Not right now.']);
  });

  it('gives the first reply primary focus and the rest secondary — one button holds initial focus', () => {
    const actions = replyActions(['a', 'b', 'c']);
    expect(actions.map((a) => a.kind)).toEqual(['primary', 'secondary', 'secondary']);
  });

  it('ids each action stably by position, so card_action can be matched back to the reply text', () => {
    const actions = replyActions(['a', 'b', 'c']);
    expect(actions.map((a) => a.id)).toEqual(['reply_0', 'reply_1', 'reply_2']);
  });

  it('never exceeds the three-action floor, even given more replies than the product allows', () => {
    const actions = replyActions(['a', 'b', 'c', 'd', 'e']);
    expect(actions.length).toBeLessThanOrEqual(3);
  });
});

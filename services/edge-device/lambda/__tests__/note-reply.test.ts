import { describe, expect, it } from 'vitest';
import {
  replyIndex,
  replyText,
  markNoteReplied,
  // @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
} from '../note-reply.mjs';

const noteItem = (suggestedReplies: string[]) => ({
  pk: { S: 'HH#margaret' },
  sk: { S: 'CARD#note-1' },
  data: { S: JSON.stringify({ id: 'note-1', card: { type: 'MESSAGE', fromName: 'Sarah', transcript: 'Hello Mum', suggestedReplies } }) },
});

describe('replyIndex — which of a note’s replies the resident pressed', () => {
  it('reads the reply position from a reply action on a note card', () => {
    expect(replyIndex('note-abc', 'reply_0')).toBe(0);
    expect(replyIndex('note-abc', 'reply_2')).toBe(2);
  });

  it('ignores everything that is not a reply to a note', () => {
    expect(replyIndex('door-abc', 'reply_0')).toBeUndefined();
    expect(replyIndex('note-abc', 'dismiss')).toBeUndefined();
    expect(replyIndex('note-abc', 'reply_9')).toBeUndefined();
    expect(replyIndex('note-abc', undefined)).toBeUndefined();
  });
});

describe('replyText — the words come from the server’s own copy of the card, never the television', () => {
  it('returns the label Wick offered at that position', () => {
    expect(replyText(noteItem(['Love you too', 'Call me later', 'Thank you']), 1)).toBe('Call me later');
  });

  it('returns nothing for a position Wick never offered, or a card that is not a note', () => {
    expect(replyText(noteItem(['Love you too']), 2)).toBeUndefined();
    expect(replyText({ data: { S: JSON.stringify({ card: { type: 'DOOR' } }) } }, 0)).toBeUndefined();
    expect(replyText(undefined, 0)).toBeUndefined();
  });
});

describe('markNoteReplied — the first reply is the reply', () => {
  it('stamps the reply on the note’s CARD# item, and never overwrites an earlier one', () => {
    const input = markNoteReplied({ table: 'wick', householdId: 'margaret', cardId: 'note-1', text: 'Thank you', at: 1_700 });

    expect(input.Key).toEqual({ pk: { S: 'HH#margaret' }, sk: { S: 'CARD#note-1' } });
    expect(input.UpdateExpression).toBe('SET replyText = if_not_exists(replyText, :text), repliedAt = if_not_exists(repliedAt, :at)');
    expect(input.ConditionExpression).toBe('attribute_exists(pk)');
    expect(input.ExpressionAttributeValues).toEqual({ ':text': { S: 'Thank you' }, ':at': { N: '1700' } });
  });
});

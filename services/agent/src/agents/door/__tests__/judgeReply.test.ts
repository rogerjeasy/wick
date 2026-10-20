import { describe, expect, it } from 'vitest';
import { judgeDescribeReply } from '../describe.js';

describe('judgeDescribeReply — the model’s reply, as the card may use it', () => {
  it('keeps a description with no confidence number: none was ever measured', () => {
    expect(judgeDescribeReply('PERSON: yes\nA man in a blue jacket at the door.')).toEqual({
      candidate: { description: 'A man in a blue jacket at the door.', personVisible: true },
      reason: 'ok',
    });
  });

  it('believes the PERSON line only where the sentence agrees with it (seen live: "PERSON: yes" over two animated rats)', () => {
    expect(judgeDescribeReply('PERSON: yes\nTwo animated rats facing each other in a field.').candidate).toEqual({ description: 'Two animated rats facing each other in a field.' });
    expect(judgeDescribeReply('PERSON: no\nA woman holding a small box.').candidate).toEqual({ description: 'A woman holding a small box.' });
    expect(judgeDescribeReply('PERSON: no\nAn empty doorstep with a box beside the mat.').candidate).toEqual({ description: 'An empty doorstep with a box beside the mat.', personVisible: false });
  });

  it('says why a sentence was refused, and shows none of it', () => {
    expect(judgeDescribeReply('PERSON: no\nAn empty porch with a parcel on the step.')).toEqual({ candidate: null, reason: 'rejected by validator (example_echo): "An empty porch with a parcel on the step."' });
    expect(judgeDescribeReply('PERSON: yes\nOpen the door now.').candidate).toBeNull();
    expect(judgeDescribeReply('UNCLEAR')).toEqual({ candidate: null, reason: 'model declined: unclear frame' });
  });
});

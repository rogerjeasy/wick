import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { repeat } from '../repeat.js';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Something to ask whose answers the test hands over. */
function asking<T>() {
  const pending: Array<(answer: T) => void> = [];
  const ask = vi.fn(() => new Promise<T>((resolve) => pending.push(resolve)));
  return {
    ask,
    answer: async (answer: T) => {
      pending.shift()!(answer);
      await vi.advanceTimersByTimeAsync(0);
    },
  };
}

describe('repeat — asking again, every so often', () => {
  it('asks at once, and then at each interval', async () => {
    const heard: number[] = [];
    let n = 0;
    const ask = vi.fn(async () => (n += 1));
    repeat({ ask, onAnswer: (answer) => void heard.push(answer), everyMs: 2000 });

    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1999);
    expect(ask).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(ask).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4000);
    expect(heard).toEqual([1, 2, 3, 4]);
  });

  it('never has two asks out at once', async () => {
    const a = asking<string>();
    const heard: string[] = [];
    repeat({ ask: a.ask, onAnswer: (answer) => void heard.push(answer), everyMs: 1000 });

    await vi.advanceTimersByTimeAsync(3500);
    expect(a.ask).toHaveBeenCalledTimes(1);

    await a.answer('one');
    await vi.advanceTimersByTimeAsync(500);
    expect(a.ask).toHaveBeenCalledTimes(2);
    expect(heard).toEqual(['one']);
  });

  it('stops: nothing more is asked, and an answer still on its way is dropped', async () => {
    const a = asking<string>();
    const heard: string[] = [];
    const repeating = repeat({ ask: a.ask, onAnswer: (answer) => void heard.push(answer), everyMs: 1000 });

    repeating.stop();
    await a.answer('late');
    await vi.advanceTimersByTimeAsync(5000);

    expect(a.ask).toHaveBeenCalledTimes(1);
    expect(heard).toEqual([]);
  });

  it('stops when the answer says there is no point asking again', async () => {
    const ask = vi.fn(async () => 'gone');
    repeat({ ask, onAnswer: () => 'stop', everyMs: 1000 });

    await vi.advanceTimersByTimeAsync(5000);

    expect(ask).toHaveBeenCalledTimes(1);
  });

  it('goes on asking after an ask that threw, and says nothing of it', async () => {
    const heard: string[] = [];
    const ask = vi.fn<() => Promise<string>>().mockRejectedValueOnce(new Error('boom')).mockResolvedValue('fine');
    repeat({ ask, onAnswer: (answer) => void heard.push(answer), everyMs: 1000 });

    await vi.advanceTimersByTimeAsync(1000);

    expect(ask).toHaveBeenCalledTimes(2);
    expect(heard).toEqual(['fine']);
  });
});

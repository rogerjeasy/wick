/**
 * Asking again, every so often. Pure — it is given the one thing to ask.
 *
 * Asks at once, then at each interval; never two asks out at once; an
 * answer that arrives after it was stopped is dropped. An ask that throws
 * is an ask that failed, and the next is at the next interval.
 *
 * Used where a family member's television keeps up with something: the
 * seat beside her film, every two seconds (FamilySeat.tsx), and — in the
 * background service — what is waiting, every twenty
 * (headless/waitingService.ts). The home screen's own looks are looker.ts,
 * which also has to say what the screen shows.
 *
 * Nothing here takes anything off a screen: all a timer does is ask again.
 */
export interface Repeating {
  stop(): void;
}

export function repeat<T>(deps: {
  readonly ask: () => Promise<T>;
  /** Given each answer. Returning 'stop' ends it: there is no point asking again. */
  readonly onAnswer: (answer: T) => void | 'stop';
  readonly everyMs: number;
}): Repeating {
  let stopped = false;
  let out = false;

  const stop = (): void => {
    stopped = true;
    clearInterval(timer);
  };

  const ask = async (): Promise<void> => {
    if (stopped || out) return;
    out = true;
    try {
      const answer = await deps.ask();
      if (!stopped && deps.onAnswer(answer) === 'stop') stop();
    } catch {
      // Not answered. Asked again at the next interval.
    } finally {
      out = false;
    }
  };

  const timer = setInterval(() => void ask(), deps.everyMs);
  void ask();
  return { stop };
}

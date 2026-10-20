/**
 * This week against last week and against a usual week, in words — the
 * Rhythm baseline (rhythm/baseline.ts) as the narrative uses it.
 *
 * The same rule as weekFacts.ts, one step further: the model never counts,
 * and it never decides what is usual. comparisonLines states the only
 * comparisons it is shown; checkComparisons refuses prose that makes one
 * the facts do not ("a usual week" from a household with two weeks of
 * history); comparisonSentences says them with no model at all.
 *
 * Two thresholds come straight from the baseline. Under one observed week
 * there is no last week. Under three there is no usual week, so no verdict
 * and no "nothing unusual" — the most valuable sentence Wick writes is only
 * worth anything if it is never said on a guess.
 */
import type { RhythmDelta } from '@wick/contracts';
import { DOOR_METRIC, VISIT_METRIC_PREFIX } from '../../rhythm/baseline.js';
import { spokenTimes, times } from './words.js';

const isDoor = (d: RhythmDelta): boolean => d.metric === DOOR_METRIC;
const isVisit = (d: RhythmDelta): boolean => d.metric.startsWith(VISIT_METRIC_PREFIX);
const usualCount = (d: RhythmDelta): number => Math.round(d.baseline);
const hasUsualWeek = (deltas: readonly RhythmDelta[]): boolean => deltas.some((d) => d.verdict !== undefined);

/**
 * A visitor seen once, weeks ago, who is not expected and did not come is
 * not worth a sentence — and "Tom did not visit" about someone who never
 * does would read as a warning.
 *
 * A visitor's metric counts the door when they were expected (baseline.ts),
 * so its words say exactly that: "nobody came to the door when Maria was
 * expected", never "Maria did not visit". The door does not know who rang.
 */
function worthMentioning(d: RhythmDelta): boolean {
  return isDoor(d) || d.thisWeek > 0 || (d.lastWeek ?? 0) > 0 || usualCount(d) > 0;
}

/** What the resident keeps private takes its comparisons with it ("What Sarah sees"). */
export function visibleDeltas(
  deltas: readonly RhythmDelta[],
  hidden: { readonly door: boolean; readonly visits: boolean },
): RhythmDelta[] {
  return deltas.filter((d) => !(hidden.door && isDoor(d)) && !(hidden.visits && isVisit(d)));
}

function doorLines(d: RhythmDelta, weekComplete: boolean): string[] {
  const lines: string[] = [];
  const lastWeek = weekComplete ? 'Last week' : 'By this point last week';
  if (d.lastWeek !== undefined) {
    const nobody = weekComplete ? 'nobody came to the front door' : 'nobody had come to the front door';
    lines.push(`${lastWeek}: ${d.lastWeek === 0 ? nobody : `${times(d.lastWeek)} at the front door`}.`);
  }
  if (d.verdict !== undefined) {
    const usual = usualCount(d);
    const usualWeek = weekComplete ? 'In a usual week' : 'By this point in a usual week';
    const nobody = weekComplete ? 'nobody comes to the front door' : 'nobody has come to the front door';
    lines.push(`${usualWeek}: ${usual === 0 ? nobody : `about ${times(usual)} at the front door`}.`);
    const verdict = d.verdict === 'usual' ? 'about the usual' : `${d.verdict} callers than usual`;
    lines.push(`The front door ${weekComplete ? 'this week' : 'so far this week'}: ${verdict}.`);
  }
  return lines;
}

function visitorLines(d: RhythmDelta, weekComplete: boolean): string[] {
  const name = d.label ?? 'a regular visitor';
  const lines: string[] = [];
  const lastWeek = weekComplete ? 'Last week' : 'By this point last week';
  if (d.thisWeek === 0) {
    lines.push(weekComplete ? `Nobody came to the door when ${name} was expected this week.` : `Nobody has come to the door when ${name} was expected so far this week.`);
  }
  if (d.lastWeek !== undefined) {
    const came = weekComplete ? ['nobody came', 'someone came'] : ['nobody had come', 'someone had come'];
    lines.push(`${lastWeek}: ${d.lastWeek === 0 ? came[0] : came[1]} to the door when ${name} was expected${d.lastWeek === 0 ? '' : `, ${times(d.lastWeek)}`}.`);
  }
  if (d.verdict !== undefined) {
    const usual = usualCount(d);
    const usualWeek = weekComplete ? 'In a usual week' : 'By this point in a usual week';
    const comes = weekComplete ? ['nobody comes', 'someone comes'] : ['nobody has come', 'someone has come'];
    lines.push(`${usualWeek}: ${usual === 0 ? comes[0] : comes[1]} to the door when ${name} is expected${usual === 0 ? '' : `, about ${times(usual)}`}.`);
    const verdict = d.verdict === 'usual' ? 'about the usual' : `${d.verdict} times than usual`;
    lines.push(`The door when ${name} was expected, ${weekComplete ? 'this week' : 'so far this week'}: ${verdict}.`);
  }
  return lines;
}

/** The only comparisons the model is shown. Every number it may use from them is in comparisonNumbers. */
export function comparisonLines(deltas: readonly RhythmDelta[], weekComplete: boolean): string[] {
  const lines = deltas
    .filter(worthMentioning)
    .flatMap((d) => (isDoor(d) ? doorLines(d, weekComplete) : visitorLines(d, weekComplete)));

  if (!hasUsualWeek(deltas)) lines.push('There is not enough history yet to know what a usual week is.');
  else if (deltas.every((d) => d.verdict === 'usual')) lines.push(`Nothing unusual ${weekComplete ? 'this week' : 'so far this week'}.`);
  return lines;
}

/** The numbers comparisonLines adds to those the week's own facts allow. */
export function comparisonNumbers(deltas: readonly RhythmDelta[]): number[] {
  return deltas.filter(worthMentioning).flatMap((d) => [
    ...(d.lastWeek !== undefined ? [d.lastWeek] : []),
    ...(d.verdict !== undefined ? [usualCount(d)] : []),
  ]);
}

export type ComparisonCheck = { readonly ok: true } | { readonly ok: false; readonly detail: string };

const LAST_WEEK = /\blast week\b/i;
const USUAL = /\b(?:un)?usual(?:ly)?\b|\bnormal(?:ly)?\b|\btypical(?:ly)?\b|\bordinary\b/i;
const NOTHING_UNUSUAL = /\bnothing (?:was |is |seemed |looked )?(?:unusual|out of the ordinary)\b/i;

/**
 * Refuses a comparison the facts do not make: "last week" with no last week
 * on record, any talk of usual with no usual week yet, and "nothing
 * unusual" in a week where something was.
 */
export function checkComparisons(text: string, deltas: readonly RhythmDelta[]): ComparisonCheck {
  const refused = (match: RegExpExecArray | null): ComparisonCheck | undefined =>
    match ? { ok: false, detail: match[0] } : undefined;

  if (!deltas.some((d) => d.lastWeek !== undefined)) {
    const found = refused(LAST_WEEK.exec(text));
    if (found) return found;
  }
  if (!hasUsualWeek(deltas)) {
    const found = refused(USUAL.exec(text));
    if (found) return found;
  } else if (deltas.some((d) => d.verdict !== 'usual')) {
    const found = refused(NOTHING_UNUSUAL.exec(text));
    if (found) return found;
  }
  return { ok: true };
}

/**
 * The comparisons with no model, most important first, for the narrative
 * written from the facts alone: whoever usually comes and did not, then the
 * door, then anyone who came more than usual — or, when all is as usual,
 * the one sentence that says so. With no usual week yet, last week's door.
 *
 * `wholeWeek: false` is for a week told with part of it kept private: what
 * was out of the usual in the shared part is still said, but "nothing
 * unusual" is a claim about the whole week, and is not made for a part.
 */
export function comparisonSentences(
  deltas: readonly RhythmDelta[],
  weekComplete: boolean,
  options: { readonly wholeWeek?: boolean } = {},
): string[] {
  const doorDelta = deltas.find(isDoor);

  if (!hasUsualWeek(deltas)) {
    if (doorDelta?.lastWeek === undefined) return [];
    const lastWeek = weekComplete ? 'Last week' : 'By this point last week';
    if (doorDelta.lastWeek === 0) return [`${lastWeek} nobody ${weekComplete ? 'came' : 'had come'}.`];
    return [`${lastWeek} it was ${spokenTimes(doorDelta.lastWeek)}.`];
  }

  if (deltas.every((d) => d.verdict === 'usual')) {
    return options.wholeWeek === false ? [] : [`Nothing unusual ${weekComplete ? 'this week' : 'so far this week'}.`];
  }

  const visitors = deltas.filter(isVisit);
  const sentences: string[] = [];
  for (const d of visitors.filter((v) => v.verdict === 'fewer')) {
    const usual = `about ${spokenTimes(usualCount(d))}`;
    if (weekComplete) {
      sentences.push(d.thisWeek === 0
        ? `Nobody came to the door when ${d.label} was expected; usually someone does, ${usual} a week.`
        : `Usually someone comes to the door when ${d.label} is expected ${usual} a week.`);
    } else {
      sentences.push(d.thisWeek === 0
        ? `Nobody has come to the door when ${d.label} was expected so far; usually someone has, ${usual} by now.`
        : `Usually someone has come to the door when ${d.label} was expected ${usual} by now.`);
    }
  }
  if (doorDelta?.verdict === 'more') sentences.push(weekComplete ? 'The front door had more callers than usual.' : 'The front door has had more callers than usual so far.');
  if (doorDelta?.verdict === 'fewer') sentences.push(weekComplete ? 'The front door was quieter than usual.' : 'The front door has been quieter than usual so far.');
  for (const d of visitors.filter((v) => v.verdict === 'more')) {
    sentences.push(weekComplete
      ? `Someone came to the door when ${d.label} was expected more often than usual.`
      : `Someone has come to the door when ${d.label} was expected more often than usual so far.`);
  }
  return sentences;
}

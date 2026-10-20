/**
 * The panel about her home, beside the conversation on a wide screen and a
 * sheet on a telephone: her light, her televisions and whether each is on,
 * who is in the circle, who is expected next, and — in a demo — that it is
 * one. Drawn only from what the app has already been told (GET /api/me,
 * GET /api/circle, get_light, get_errands): nothing is asked for it alone,
 * and nothing is shown that was not given.
 *
 * No DOM and no network, so it is tested (./__tests__/layout.test.ts);
 * main.js draws it.
 */
import { count, televisionLine } from './surface.js';
import { errandsToCome } from './errands.js';

const PEOPLE = (n) => `${count(n)} ${n === 1 ? 'person' : 'people'}`;

/**
 * @param {{ me: object, circle?: object | null, light?: { lit: boolean } | null, errands?: string | null }} known
 */
export function presentHome({ me, circle = null, light = null, errands = null }) {
  const household = me?.household ?? {};
  const resident = household.residentName ?? 'Her';
  const televisions = circle
    ? [...circle.televisions].sort((a, b) => (a.pairedAt ?? 0) - (b.pairedAt ?? 0) || String(a.ref).localeCompare(String(b.ref)))
    : null;
  const members = circle ? circle.members.filter((m) => m.status !== 'removed') : null;
  const waiting = members ? members.filter((m) => m.status === 'pending').length : 0;
  return {
    title: `${resident}’s home`,
    // A demo home says what it is wherever it is named: its history was written, not lived.
    demo: household.simulated ? `${household.name}${household.demoSession ? ` ${household.demoSession}` : ''} · simulated history` : null,
    virtualTelevisionUrl: typeof me?.virtualTelevisionUrl === 'string' ? me.virtualTelevisionUrl : null,
    light: light ? { lit: light.lit, words: light.lit ? 'Her light is on' : 'Her light is not on' } : null,
    televisions: televisions
      ? {
          line: televisionLine(televisions),
          rows: televisions.map((tv, i) => ({ name: `Television ${i + 1}`, on: tv.connected === true, state: tv.connected ? 'On now' : 'Off, or showing something else' })),
        }
      : null,
    circle: members
      ? `${PEOPLE(members.length)} in the family circle.${waiting ? ` ${count(waiting)} ${waiting === 1 ? 'is' : 'are'} waiting for ${resident} to allow them.` : ''}`
      : null,
    expected: typeof errands === 'string' ? errandsToCome(errands) : null,
  };
}

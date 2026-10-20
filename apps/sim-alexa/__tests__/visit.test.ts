/**
 * The visitor's page (visit.html, visit.js, visit-state.js): the link a
 * family member forwards to the visitor they arranged, with three buttons
 * and nothing about the house. What the page says and does in each state is
 * decided in visit-state.js, with no DOM and no network, and held here; the
 * page itself only draws it.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
// @ts-expect-error — a plain browser module, deliberately untyped (no build step).
import * as V from '../visit-state.js';
import { VISITOR_SAYS, VISIT_PASS_LIMITS, VISIT_PAGE_PATH, isVisitPassToken } from '../../../packages/contracts/src/visitPass.js';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const TOKEN = '0123456789abcdef0123456789abcdef';
const EDGE = 'https://edge.example';
const NINE_FORTY_ONE = Date.UTC(2026, 9, 22, 9, 41);
/** The page's clock, fixed: "9:41" for the minute above, whatever the machine's zone. */
const at = (ms: number) => (ms === NINE_FORTY_ONE ? '9:41 am' : `t${ms}`);

type Model = Record<string, unknown>;
const run = (...events: Record<string, unknown>[]) => events.reduce<Model>((m, e) => V.nextModel(m, e), V.firstModel(TOKEN));
const opened = (body: Record<string, unknown> = { state: 'open' }) => run({ type: 'answer', status: 200, body });
const view = (model: Model) => V.presentVisit(model, at);

describe('the visitor’s page — held to the contract (packages/contracts visitPass.ts)', () => {
  it('knows the same three things to say, the same step for running late, and the same page', () => {
    expect(V.VISITOR_SAYS).toEqual([...VISITOR_SAYS]);
    expect(V.LATE_STEP_MINUTES).toBe(VISIT_PASS_LIMITS.lateStepMinutes);
    expect(V.VISIT_PAGE_PATH).toBe(VISIT_PAGE_PATH);
    expect(VISIT_PAGE_PATH).toBe('/visit.html');
  });

  it('reads a token as the contract does: 32 lower-case hex characters, after the #', () => {
    for (const candidate of [TOKEN, TOKEN.toUpperCase(), TOKEN.slice(1), `${TOKEN}0`, 'g'.repeat(32), '', 'dr-rossi']) {
      expect(V.tokenFromHash(`#${candidate}`), candidate).toBe(isVisitPassToken(candidate) ? candidate : undefined);
    }
    expect(V.tokenFromHash('')).toBeUndefined();
    expect(V.tokenFromHash(TOKEN)).toBe(TOKEN);
  });
});

describe('visitRequest — the token goes in the body to the edge, and nowhere else', () => {
  it('asks how the pass stands, with the token in the body only', () => {
    const { url, init } = V.visitRequest(EDGE, TOKEN);

    expect(url).toBe('https://edge.example/visit/status');
    expect(url).not.toContain(TOKEN);
    expect(init.method).toBe('POST');
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN });
    expect(init.headers).toEqual({ 'content-type': 'application/json' });
    // No cookie, no Referer, nothing kept by the browser's cache.
    expect(init.credentials).toBe('omit');
    expect(init.referrerPolicy).toBe('no-referrer');
    expect(init.cache).toBe('no-store');
  });

  it('says one of the three, and only one of them', () => {
    const { url, init } = V.visitRequest(`${EDGE}/`, TOKEN, 'at_door');
    expect(url).toBe('https://edge.example/visit/say');
    expect(JSON.parse(init.body)).toEqual({ token: TOKEN, says: 'at_door' });
    expect(() => V.visitRequest(EDGE, TOKEN, 'come_in')).toThrow();
  });

  it('takes the edge’s address only as an http(s) origin, as the deploy writes it into the page', () => {
    expect(V.edgeFrom('https://abc.execute-api.eu-west-2.amazonaws.com')).toBe('https://abc.execute-api.eu-west-2.amazonaws.com');
    expect(V.edgeFrom('https://abc.example/')).toBe('https://abc.example');
    for (const bad of [undefined, '', 'javascript:alert(1)', 'not a url', 'ftp://x.example']) expect(V.edgeFrom(bad), String(bad)).toBeUndefined();
  });
});

describe('nextModel and presentVisit — what the page shows as the pass answers', () => {
  it('opens on “checking”, and with no token, or one that is not a token, says the link has ended without asking anyone', () => {
    expect(view(V.firstModel(TOKEN))).toMatchObject({ heading: 'Your visit', lead: 'Opening your link…', busy: true, buttons: [] });
    for (const model of [V.firstModel(undefined), V.firstModel('')]) {
      expect(model.phase).toBe('over');
      expect(view(model).heading).toBe('This link has ended.');
    }
  });

  it('shows the three buttons when the pass is open, the door last and first in weight', () => {
    const shown = view(opened());

    expect(shown.heading).toBe('Your visit');
    expect(shown.busy).toBe(false);
    expect(shown.buttons.map((b: { says: string; label: string; primary: boolean }) => [b.says, b.label, b.primary])).toEqual([
      ['on_way', 'On my way', false],
      ['late', 'Running late', false],
      ['at_door', 'I’m at the door', true],
    ]);
    expect(shown.result).toBeNull();
    expect(shown.retry).toBeNull();
  });

  it('after a press: thanks, and what was said and when', () => {
    const pressing = V.nextModel(opened(), { type: 'press', says: 'on_way' });
    const working = view(pressing);
    expect(working.buttons.find((b: { says: string }) => b.says === 'on_way').working).toBe(true);
    // One press at a time: the others wait for its answer.
    expect(working.buttons.every((b: { disabled: boolean }) => b.disabled)).toBe(true);

    const told = view(V.nextModel(pressing, { type: 'answer', status: 200, body: { state: 'open', says: 'on_way', at: NINE_FORTY_ONE } }));
    expect(told.result).toEqual({ thanks: 'Thank you. The house has been told.', last: 'You said you were on the way at 9:41 am.', tone: 'done' });
    expect(told.buttons.find((b: { says: string }) => b.says === 'on_way').last).toBe(true);
    expect(told.buttons.every((b: { disabled: boolean }) => !b.disabled)).toBe(true);
  });

  it('says how late, all told, and that running late can be pressed again', () => {
    const late = (minutes: number) =>
      view(V.nextModel(V.nextModel(opened(), { type: 'press', says: 'late' }), { type: 'answer', status: 200, body: { state: 'open', says: 'late', at: NINE_FORTY_ONE, lateMinutes: minutes } }));

    expect(late(15).result.last).toBe('You said at 9:41 am that you would be about 15 minutes late.');
    expect(late(30).result.last).toBe('You said at 9:41 am that you would be about 30 minutes late.');
    expect(view(opened()).buttons[1].hint).toBe('About 15 minutes');
    expect(late(30).buttons[1].hint).toBe('Press again to add 15 minutes');
  });

  it('says at the door as at the door', () => {
    const door = view(opened({ state: 'open', says: 'at_door', at: NINE_FORTY_ONE }));
    // Opened again later: what was said last, without a thank-you for a press made before.
    expect(door.result).toEqual({ last: 'You said you were at the door at 9:41 am.', tone: 'done' });
  });

  it('ignores a word it cannot read rather than saying something wrong', () => {
    for (const body of [{ state: 'open', says: 'come_in', at: NINE_FORTY_ONE }, { state: 'open', says: 'late', at: NINE_FORTY_ONE }, { state: 'open', says: 'on_way' }]) {
      expect(view(opened(body)).result, JSON.stringify(body)).toBeNull();
    }
  });

  it('says honestly when the link is not open yet, and offers to look again', () => {
    const shown = view(opened({ state: 'not_yet' }));
    expect(shown.heading).toBe('This link is not open yet.');
    expect(shown.lead).toBe('It opens on the day of the visit, three hours before it is due. Please come back to it then.');
    expect(shown.buttons).toEqual([]);
    expect(shown.retry).toEqual({ label: 'Check again' });
    expect(V.nextModel(opened({ state: 'not_yet' }), { type: 'retry' }).phase).toBe('loading');
  });

  it('says the same thing for a link that has ended and for one it does not know: no oracle', () => {
    const ended = view(opened({ state: 'over' }));
    expect(ended.heading).toBe('This link has ended.');
    expect(ended.buttons).toEqual([]);
    expect(ended.retry).toBeNull();
    for (const status of [400, 403, 404, 410]) expect(view(run({ type: 'answer', status, body: {} }))).toEqual(ended);
    expect(view(run({ type: 'answer', status: 200, body: { state: 'something' } }))).toEqual(ended);
  });

  it('when the house cannot be reached, says so and offers to try again', () => {
    for (const event of [{ type: 'failed' }, { type: 'answer', status: 502, body: {} }, { type: 'answer', status: 429, body: { message: 'Too Many Requests' } }]) {
      const shown = view(run(event));
      expect(shown.heading, JSON.stringify(event)).toBe('This page could not reach the house.');
      expect(shown.lead).toBe('Check that your phone is online, then try again.');
      expect(shown.retry).toEqual({ label: 'Try again' });
    }
  });

  it('keeps the buttons when a press is not sent, and says it was not', () => {
    const unsent = view(V.nextModel(V.nextModel(opened({ state: 'open', says: 'on_way', at: NINE_FORTY_ONE }), { type: 'press', says: 'at_door' }), { type: 'failed' }));
    expect(unsent.heading).toBe('Your visit');
    expect(unsent.buttons).toHaveLength(3);
    expect(unsent.buttons.every((b: { disabled: boolean }) => !b.disabled)).toBe(true);
    expect(unsent.result).toEqual({ problem: 'That was not sent. Check that your phone is online, then press it again.', last: 'You said you were on the way at 9:41 am.', tone: 'problem' });
  });

  it('when the pass has been pressed as often as it may be, says the house has the last word', () => {
    const busy = view(V.nextModel(V.nextModel(opened({ state: 'open', says: 'late', at: NINE_FORTY_ONE, lateMinutes: 30 }), { type: 'press', says: 'late' }), { type: 'answer', status: 429, body: { state: 'open', busy: true } }));
    expect(busy.result).toEqual({
      problem: 'This link cannot be pressed any more. The house has what you said last.',
      last: 'You said at 9:41 am that you would be about 30 minutes late.',
      tone: 'problem',
    });
  });

  it('a press on a pass that has since ended or is not yet open shows that state instead', () => {
    expect(V.nextModel(V.nextModel(opened(), { type: 'press', says: 'at_door' }), { type: 'answer', status: 200, body: { state: 'over' } }).phase).toBe('over');
  });

  it('takes no press while one is under way, nor when the pass is not open', () => {
    const pressing = V.nextModel(opened(), { type: 'press', says: 'on_way' });
    expect(V.nextModel(pressing, { type: 'press', says: 'at_door' })).toBe(pressing);
    const ended = opened({ state: 'over' });
    expect(V.nextModel(ended, { type: 'press', says: 'at_door' })).toBe(ended);
    expect(V.nextModel(opened(), { type: 'press', says: 'come_in' }).pending).toBeUndefined();
  });
});

describe('the visitor’s page — nothing about the house, and nothing from elsewhere', () => {
  const html = read('../visit.html');
  const js = read('../visit.js');
  const state = read('../visit-state.js');

  it('is called “Your visit · Wick”, and names nobody: not her, not the member, not the visitor, not the household', () => {
    expect(html).toContain('<title>Your visit · Wick</title>');
    // What can be seen or heard: the page without its comments, and every string the scripts can put on it.
    const shown = [
      html.replace(/<!--[\s\S]*?-->/g, ''),
      ...[js, state].flatMap((source) => source.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '').match(/'[^']*'|`[^`]*`/g) ?? []),
    ];
    for (const words of shown) expect(words).not.toMatch(/Margaret|Sarah|Rossi|household|resident|address|street|road/i);
  });

  it('runs under the family app’s policy: no inline script, style or handler', () => {
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const script of html.match(/<script[^>]*>/gi) ?? []) expect(script).toMatch(/\ssrc="\.\//);
  });

  it('loads nothing from another site: its one address is the edge’s, which the deploy writes in (infra/sim-alexa.tf)', () => {
    const urls = [...html.matchAll(/(?:href|src|content)="(https?:[^"]*)"/g)].map((m) => m[1]);
    expect(urls).toEqual(['http://127.0.0.1:3300']);
    expect(html).toContain('<meta name="wick-edge-api" content="http://127.0.0.1:3300" />');
    expect(html).not.toContain('manifest');
  });

  it('reads the token from the address’s # only, and never writes it anywhere', () => {
    expect(js).toContain('location.hash');
    expect(js).not.toMatch(/location\.search|URLSearchParams|localStorage|sessionStorage|document\.cookie|console\./);
  });
});

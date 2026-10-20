/**
 * Her television in a browser (tv.html): tv-engine.generated.js, tv-core.js
 * and tv.js, run in the order the page loads them, in a page of the test's
 * own (tvPage.ts). What is held here is what she sees and what her remote
 * does: the home screen, the natural break — a note waits while the film
 * plays and comes at a pause, a measured calm point or the credits, and
 * holds the film while it is shown; the door never waits — the keys, the
 * second a card takes no press, Hold for Sarah, reading aloud, and "Easier
 * to see". How it looks is checked in a real browser.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CATALOG, DOOR, NOTE, REMEMBERED, TV_SOURCE, queued, tvPage, type El, type FakeEvent } from './tvPage.js';
import { PAUSE_IS_BREAK_MS, SETTLED_AFTER_MS } from '../../tv-vega/src/break/types.js';
import { PRESS_SETTLE_MS } from '../../tv-vega/src/press/settle.js';
import { HOLD_MS } from '../../tv-vega/src/watch/hold.js';
import { WORDS } from '../../tv-vega/src/words/words.js';
import { contrastRatio, alarmHue } from '../../../packages/vega-calm-ui/src/constraints.js';
import { buildTellCard } from '../../../services/agent/src/agents/tell/ask.js';
import { palette, type as calmType } from '../../../packages/vega-calm-ui/src/tokens.js';

const BUNNY = CATALOG.programmes.find((p) => p.id === 'big-buck-bunny')!;

/** Paired, connected, the films come, and she has been on her home screen long enough for a note to be shown there. */
async function atHome(opts: Parameters<typeof tvPage>[0] = {}) {
  const tv = tvPage({ remembered: REMEMBERED, ...opts });
  tv.open();
  await tv.catalogue();
  tv.home({ light: 'on' });
  return tv;
}

/** Choose the first film with OK, and the player starts. */
async function watching(tv: Awaited<ReturnType<typeof atHome>>) {
  tv.advance(PRESS_SETTLE_MS);
  tv.press('Enter');
  const video = tv.video()!;
  video.duration = BUNNY.durationMs / 1000;
  await video.play();
  tv.advance(1000);
  return video;
}

/** The film is at this place, and a second passes so the television has looked. */
function at(tv: ReturnType<typeof tvPage>, video: NonNullable<ReturnType<ReturnType<typeof tvPage>['video']>>, ms: number) {
  video.currentTime = ms / 1000;
  tv.advance(1000);
}

const shownType = (tv: ReturnType<typeof tvPage>) => tv.run('currentQueuedCard?.card.type ?? null');

describe('tv.html — the page is the television and nothing else', () => {
  const html = readFileSync(fileURLToPath(new URL('../tv.html', import.meta.url)), 'utf8');

  it('loads its libraries, the television’s rules, the television, then the page, and no script of its own', () => {
    expect([...html.matchAll(/<script src="([^"]+)"><\/script>/g)].map((m) => m[1])).toEqual([
      'vendor/icons.generated.js',
      'vendor/motion.generated.js',
      'tv-engine.generated.js',
      'tv-channels.generated.js',
      'tv-core.js',
      'tv.js',
    ]);
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    expect(html.match(/<script/g)).toHaveLength(6);
  });

  it('has no console: no telemetry, no raw messages, no badge', () => {
    for (const console of ['conn-badge', 'fg-btn', 'reach-btn', 'id="log"', 'Raw messages', 'ops console', 'Pair &amp; connect', 'device.js']) expect(html).not.toContain(console);
  });

  it('is published with every file it loads, the posters among them, under the ops console’s security headers', () => {
    const tf = readFileSync(fileURLToPath(new URL('../../../infra/ops-console.tf', import.meta.url)), 'utf8');
    const files = [...html.matchAll(/(?:href|src)="([^":#]+)"/g)].map((m) => m[1]!);
    expect(files).toEqual(['vendor/fonts.css', 'vendor/open-props.css', 'tv.css', 'vendor/icons.generated.js', 'vendor/motion.generated.js', 'tv-engine.generated.js', 'tv-channels.generated.js', 'tv-core.js', 'tv.js']);
    const own = files.filter((file) => !file.startsWith('vendor/'));
    for (const file of [...own, 'tv.html', 'tv-catalog.json', 'parcel.jpg']) expect(tf, file).toContain(`key           = "${file}"`);
    // The libraries go up as one set, each file named (tv-build.test.ts holds the set to what `npm run web:vendor` writes).
    for (const file of files.filter((f) => f.startsWith('vendor/'))) expect(tf, file).toContain(`"${file.slice('vendor/'.length)}"`);
    expect(tf).toContain('key           = "posters/${each.value}"');
    // The cards come by IoT Core first: the page is given its address, and the policy lets the page reach it.
    expect(tf).toContain('"MQTT_WSS_URL_PLACEHOLDER"');
    expect(tf).toContain('data.aws_iot_endpoint.data.endpoint_address');
    expect(readFileSync(fileURLToPath(new URL('../../../infra/csp/ops-console.csp', import.meta.url)), 'utf8')).toMatch(/connect-src[^;]*\$\{iot\}/);
    expect(TV_SOURCE).toContain('`posters/${programme.id}.jpg`');
    for (const p of CATALOG.programmes) readFileSync(fileURLToPath(new URL(`../../tv-vega/assets/image/${p.id}.jpg`, import.meta.url)));
    // One distribution, one policy: every page of the site is answered with it.
    expect(tf).toMatch(/response_headers_policy_id = aws_cloudfront_response_headers_policy\.ops_console\.id/);
  });

  it('lists each key the remote is: the arrows, OK, the hold, Back, Play', () => {
    for (const key of ['← ↑ → ↓', 'Enter', 'Hold Enter 2 s', 'Backspace or Esc', 'Space or P']) expect(html).toContain(`<dt>${key}</dt>`);
  });
});

describe('pairing — the code, large, and one sentence on where to enter it', () => {
  it('asks for a code at once, and shows it with the keys of the remote', async () => {
    const tv = tvPage();
    const start = tv.asked.find((a) => a.url.endsWith('/pair/start'))!;
    expect(start.method).toBe('POST');
    start.answer(200, { code: '123456', url: 'https://family.example/?pair=123456' });
    await tv.settle();

    expect(tv.says()).toEqual(['Set up Wick', '123 456', 'In the Wick family app, choose “Connect a television” and enter this code.', 'https://family.example/?pair=123456', 'Or point a phone at this.']);
    // The link as a QR code beside the words: one light ground, and the dark modules in runs (packages/contracts qr.ts).
    const qr = tv.screen.all().find((n) => n.tagName === 'svg');
    expect(qr?.getAttribute('aria-label')).toBe('A code for a phone camera. It opens the Wick family app with this code filled in.');
    expect(qr!.children.filter((n) => n.tagName === 'rect').length).toBeGreaterThan(100);
    expect(tv.keysPanel.hidden).toBe(false);
    // Under the screen, never over it: the screen is made smaller to leave it room.
    expect(tv.page.document.getElementById('stage').classList.contains('keys-shown')).toBe(true);
  });

  it('says so calmly when the home cannot be reached, and tries again by itself', async () => {
    const tv = tvPage();
    tv.asked.find((a) => a.url.endsWith('/pair/start'))!.answer(503);
    await tv.settle();
    expect(tv.says()).toContain(WORDS.en['pairing.stillTrying']);

    tv.advance(5000);
    await tv.settle();
    expect(tv.asked.filter((a) => a.url.endsWith('/pair/start'))).toHaveLength(2);
  });
});

describe('disconnected from the family app — the pairing screen again, as on Vega', () => {
  it('shows a new code once the pairing service says no home holds this television', async () => {
    const tv = await atHome();
    tv.advance(60_000);
    const refresh = tv.asked.find((a) => a.url.endsWith('/pair/refresh'))!;
    refresh.answer(404);
    await tv.settle();

    expect(tv.says()).toContain(WORDS.en['pairing.gettingCode']);
    tv.asked.find((a) => a.url.endsWith('/pair/start'))!.answer(200, { code: '654321' });
    await tv.settle();
    expect(tv.says()).toContain('654 321');
    expect(tv.tab.size).toBe(0);
  });
});

describe('the home screen — what the Vega home shows', () => {
  it('asks what she would like to watch, beside her light, over the three films, with who looked in and “Easier to see”', async () => {
    const tv = await atHome();
    tv.home({ light: 'on', lookedIn: { name: 'Sarah', at: Date.now(), line: 'Sarah looked in this morning.', until: 1_800_000_000_000 + 3_600_000 } });

    expect(tv.says()).toEqual([
      WORDS.en['home.question'],
      'Light on',
      ...CATALOG.programmes.flatMap((p) => [p.title, `${Math.round(p.durationMs / 60_000)} minutes`]),
      'Sarah looked in this morning.',
      'Easier to see',
      WORDS.en['home.tour'],
    ]);
    // The focus starts on the first film, never a pill.
    expect(tv.focused()?.dataset.key).toBe('programme:big-buck-bunny');
  });

  it('offers her mantelpiece only when she has kept something', async () => {
    const tv = await atHome();
    expect(tv.buttons()).not.toContain('Mantelpiece');
    tv.home({ light: 'on', mantel: 2 });
    expect(tv.buttons()).toContain('Mantelpiece');
  });

  it('says it in her language', async () => {
    const tv = await atHome();
    tv.home({ light: 'on', language: 'es' });
    expect(tv.says()[0]).toBe(WORDS.es['home.question']);
    expect(tv.says()).toContain('Más fácil de ver');
  });

  it('asks for the light’s card with OK on the light, and shows it at once', async () => {
    const tv = await atHome();
    tv.press('ArrowUp');
    expect(tv.focused()?.dataset.key).toBe('light');
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    expect(tv.sentOf('light')).toHaveLength(1);

    tv.card(queued({ id: 'light-1', type: 'LIGHT', headline: 'Your light is on.', detail: 'Sarah can see it.', actions: [{ id: 'ok', label: 'All right', kind: 'primary' }] }));
    expect(shownType(tv)).toBe('LIGHT');
  });
});

describe('her day at the top — the greeting, the date, who is coming (home/herDay.ts)', () => {
  /** The page's clock starts at 1_800_000_000_000: Friday 15 January 2027, 08:00 UTC — the morning in London. */
  const start = Date.parse('2027-01-15T00:00:00Z');
  const today = {
    weekday: 4,
    day: 15,
    month: 0,
    name: 'Margaret',
    dayStart: start,
    dayEnd: start + 24 * 3_600_000,
    coming: [{ line: 'Maria usually comes today at 9 am.', until: start + 9.5 * 3_600_000 }],
  };

  it('greets her by name in place of the question, says the date, and who is coming — her light joins the pills', async () => {
    const tv = await atHome();
    tv.home({ light: 'on', today });

    expect(tv.says()).toEqual([
      'Good morning, Margaret.',
      'Friday 15 January',
      'Maria usually comes today at 9 am.',
      ...CATALOG.programmes.flatMap((p) => [p.title, `${Math.round(p.durationMs / 60_000)} minutes`]),
      'Light on',
      'Easier to see',
      WORDS.en['home.tour'],
    ]);
    // Read, never pressed: the focus still starts on the first film.
    expect(tv.focused()?.dataset.key).toBe('programme:big-buck-bunny');
  });

  it('lets the line go once Maria’s time is over, with nothing pressed', async () => {
    const tv = await atHome();
    tv.home({ today });
    tv.advance(1.6 * 3_600_000);
    expect(tv.says()).not.toContain('Maria usually comes today at 9 am.');
    expect(tv.says()[0]).toBe('Good morning, Margaret.');
  });

  it('says it in her language', async () => {
    const tv = await atHome();
    tv.home({ language: 'es', today: { ...today, coming: [{ line: 'Maria suele venir hoy a las 9:00.', until: today.coming[0]!.until }] } });
    expect(tv.says().slice(0, 3)).toEqual(['Buenos días, Margaret.', 'Viernes 15 de enero', 'Maria suele venir hoy a las 9:00.']);
  });

  it('asks for her day again a little after a new card comes — a visit may just have been arranged — and not before', async () => {
    const tv = await atHome();
    tv.home({ today });
    tv.advance(2_000);
    expect(tv.sentOf('home')).toHaveLength(0);
    tv.card(queued({ id: 'note-errand-1', type: 'MESSAGE', fromName: 'Sarah', transcript: 'The window cleaner is coming at 10:18 am today.', suggestedReplies: ['Thank you!', 'OK', 'Lovely'] }));
    tv.advance(1_000);
    expect(tv.sentOf('home')).toHaveLength(0);
    tv.advance(3_000);
    expect(tv.sentOf('home')).toHaveLength(1);
  });

  it('is the question, as it always was, from a server that says no day', async () => {
    const tv = await atHome();
    tv.home({ light: 'on' });
    expect(tv.says()[0]).toBe(WORDS.en['home.question']);
  });
});

describe('"Shall I tell Sarah?" in a browser tab', () => {
  it('starts on "Keep it to myself", as the card the agent plane builds puts it first', async () => {
    const tv = await atHome();
    tv.card(buildTellCard({ householdId: 'hh-1', differenceId: 'd_1', who: 'Sarah', sentence: 'There was no visit on Tuesday.', correlationId: 'c-1', now: 0 }));
    tv.advance(SETTLED_AFTER_MS);

    expect(shownType(tv)).toBe('TELL');
    expect(tv.focused()?.textContent).toBe('Keep it to myself');
  });
});

describe('the natural break — the Vega app’s own engine, on a film that plays here', () => {
  it('shows a note on the home screen once she has settled there, and not before', async () => {
    const tv = await atHome();
    tv.card(NOTE);
    expect(shownType(tv)).toBe(null);

    tv.advance(SETTLED_AFTER_MS);
    expect(shownType(tv)).toBe('MESSAGE');
    expect(tv.sentOf('card_shown')).toEqual([{ t: 'card_shown', cardId: 'note-1' }]);
  });

  it('plays the film she chooses, from the films’ own origin, with no controls of the browser’s', async () => {
    const tv = await atHome();
    const video = await watching(tv);

    expect(video.controls).toBe(false);
    expect(tv.run('film.programmeId')).toBe('big-buck-bunny');
    // The home screen is not under the film.
    expect(tv.says()).not.toContain(WORDS.en['home.question']);
    expect(tv.sentOf('playback').at(-1)).toMatchObject({ state: 'PLAYING', contentId: 'big-buck-bunny' });
  });

  it('keeps a note waiting while the film plays (INV-5)', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(NOTE);
    for (let s = 0; s < 30; s++) at(tv, video, 10_000 + s * 1000);

    expect(shownType(tv)).toBe(null);
    expect(video.paused).toBe(false);
    expect(tv.sentOf('card_shown')).toEqual([]);
  });

  it('brings the door at once, over the playing film, and holds the film for it: she may get up to answer it', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(NOTE);
    tv.card(DOOR());

    expect(shownType(tv)).toBe('DOOR');
    expect(video.paused).toBe(true);
    tv.advance(3000);
    expect(video.paused).toBe(true);
  });

  it('plays the film on when she puts the door card away herself', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(DOOR());
    expect(video.paused).toBe(true);

    tv.advance(PRESS_SETTLE_MS);
    tv.press('Escape');
    expect(tv.sentOf('card_action')).toEqual([{ t: 'card_action', cardId: 'door-1', action: 'dismiss' }]);
    tv.advance(1000);
    expect(shownType(tv)).toBe(null);
    expect(video.paused).toBe(false);
  });

  it('leaves the film paused when the door card goes by itself, while she is at the door', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(DOOR());
    expect(video.paused).toBe(true);

    // Five minutes and more: the card's own clock runs out, and nobody pressed anything.
    tv.advance(5 * 60_000 + 2000);
    expect(shownType(tv)).toBe(null);
    expect(video.paused).toBe(true);
  });

  it('shows the note at a pause of hers, and the film stays paused after it is answered', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(NOTE);
    tv.press(' ');
    expect(video.paused).toBe(true);

    tv.advance(PAUSE_IS_BREAK_MS);
    expect(shownType(tv)).toBe(null);
    tv.advance(1000);
    expect(shownType(tv)).toBe('MESSAGE');

    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    expect(tv.sentOf('card_action')).toEqual([{ t: 'card_action', cardId: 'note-1', action: 'reply_0' }]);
    tv.advance(1000);
    expect(shownType(tv)).toBe(null);
    // She paused it herself: it stays paused.
    expect(video.paused).toBe(true);
  });

  it('shows the note at a measured calm point, holds the film on the cut, and plays on once it is answered', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(NOTE);
    const calm = BUNNY.calmPointsMs[0]!;
    at(tv, video, calm - 2000);
    expect(shownType(tv)).toBe(null);

    at(tv, video, calm + 200);
    expect(shownType(tv)).toBe('MESSAGE');
    expect(video.paused).toBe(true);

    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    tv.advance(1000);
    expect(shownType(tv)).toBe(null);
    expect(video.paused).toBe(false);
  });

  it('shows it at the credits without holding anything: the story is over', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(NOTE);
    at(tv, video, BUNNY.creditsPositionMs + 1000);

    expect(shownType(tv)).toBe('MESSAGE');
    expect(video.paused).toBe(false);
  });

  it('reads the note on Play and stops the reading on the next — Play never moves the film under a card', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.card(NOTE);
    tv.press(' ');
    tv.advance(PAUSE_IS_BREAK_MS + 1000);
    expect(shownType(tv)).toBe('MESSAGE');

    tv.press('p');
    expect(tv.sentOf('read')).toEqual([{ t: 'read', cardId: 'note-1' }]);
    expect(video.paused).toBe(true);

    tv.press(' ');
    expect(video.paused).toBe(true);
    expect(shownType(tv)).toBe('MESSAGE');
    expect(tv.sentOf('read')).toHaveLength(1);
  });

  it('says which state of a break it is in, as the Vega app does', async () => {
    const tv = await atHome();
    await watching(tv);
    expect(tv.sentOf('break_state').map((e) => e.state)).toContain('IN_SCENE');
  });
});

describe('the remote — a press obeys the one-second settle, and must begin where it ends', () => {
  it('takes no press in a card’s first second on screen, by key or by click, and the next press works', async () => {
    const tv = await atHome();
    tv.card(DOOR());
    tv.press('Enter');
    tv.screen.querySelector('button')!.click();
    expect(tv.sentOf('card_action')).toEqual([]);

    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    expect(tv.sentOf('card_action')).toEqual([{ t: 'card_action', cardId: 'door-1', action: 'dismiss' }]);
  });

  it('does nothing with an OK that went down on another screen', async () => {
    const tv = await atHome();
    tv.advance(PRESS_SETTLE_MS);
    tv.keyDown('Enter');
    tv.card(DOOR());
    tv.advance(PRESS_SETTLE_MS);
    tv.keyUp('Enter');
    expect(tv.sentOf('card_action')).toEqual([]);
  });

  it('holds OK for two seconds on the home screen to ask someone to ring her — and starts no film', async () => {
    const tv = await atHome();
    tv.advance(PRESS_SETTLE_MS);
    tv.keyDown('Enter');
    tv.advance(HOLD_MS);
    tv.keyUp('Enter');

    expect(tv.sentOf('reach')).toHaveLength(1);
    expect(tv.video()).toBe(null);
  });

  it('takes a short OK as a press', async () => {
    const tv = await atHome();
    tv.advance(PRESS_SETTLE_MS);
    tv.keyDown('Enter');
    tv.advance(HOLD_MS - 500);
    tv.keyUp('Enter');

    expect(tv.sentOf('reach')).toHaveLength(0);
    expect(tv.video()).not.toBe(null);
  });

  it('pauses and plays the film with OK, and moves it thirty seconds with left and right', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    video.currentTime = 60;
    tv.press('Enter');
    expect(video.paused).toBe(true);
    tv.press('Enter');
    expect(video.paused).toBe(false);
    tv.press('ArrowRight');
    expect(video.currentTime).toBe(90);
    tv.press('ArrowLeft');
    expect(video.currentTime).toBe(60);
  });

  it('goes back from the film to the home screen, to the film she watched', async () => {
    const tv = await atHome();
    await watching(tv);
    tv.press('Backspace');

    expect(tv.video()).toBe(null);
    expect(tv.says()[0]).toBe(WORDS.en['home.question']);
    expect(tv.focused()?.dataset.key).toBe('programme:big-buck-bunny');
    expect(tv.sentOf('playback').at(-1)).toMatchObject({ state: 'STOPPED' });
  });

  it('answers the card her hold brought with Back, as the Vega app does', async () => {
    const tv = await atHome();
    tv.advance(PRESS_SETTLE_MS);
    tv.keyDown('Enter');
    tv.advance(HOLD_MS);
    tv.keyUp('Enter');
    tv.card(
      queued({ id: 'reach-1', type: 'REACH', headline: 'Ask Sarah to ring you?', actions: [{ id: 'ring_me', label: 'Yes, ask Sarah', kind: 'primary' }, { id: 'not_now', label: 'No, not now', kind: 'secondary' }] }, 'DEFERRED', { respondsTo: 'reach' }),
    );
    expect(shownType(tv)).toBe('REACH');

    tv.advance(PRESS_SETTLE_MS);
    tv.press('Escape');
    expect(tv.sentOf('card_action')).toEqual([{ t: 'card_action', cardId: 'reach-1', action: 'not_now' }]);
  });
});

describe('nextFocus — where an arrow goes', () => {
  const box = (left: number, top: number, width = 100, height = 50) => ({ left, top, width, height });
  const next = (from: unknown, boxes: unknown[], dir: string) => {
    const tv = tvPage({ remembered: REMEMBERED });
    return tv.run(`nextFocus(${JSON.stringify(from)}, ${JSON.stringify(boxes)}, '${dir}')`);
  };

  it('moves along a row before it jumps to the next', () => {
    // Two buttons on a row, a third under the first.
    expect(next(box(0, 0), [box(120, 0), box(0, 70)], 'right')).toBe(0);
    expect(next(box(0, 0), [box(120, 0), box(0, 70)], 'down')).toBe(1);
  });

  it('stays where it is when nothing is that way', () => {
    expect(next(box(0, 0), [box(120, 0)], 'left')).toBe(-1);
    expect(next(box(0, 0), [box(120, 0)], 'up')).toBe(-1);
  });
});

describe('Back on the door card over her film — it puts the card away, and never ends the film', () => {
  it('presses the card’s Not now: the card goes, the film plays on', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    at(tv, video, 30_000);
    tv.card(DOOR());
    expect(shownType(tv)).toBe('DOOR');
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Escape');
    expect(shownType(tv)).toBe(null);
    expect(tv.video()).not.toBeNull();
    expect(tv.video()!.paused).toBe(false);
  });

  it('takes a Back pressed in the card’s first second and does nothing with it: neither the card nor the film goes', async () => {
    const tv = await atHome();
    await watching(tv);
    tv.card(DOOR());
    tv.press('Escape');
    expect(shownType(tv)).toBe('DOOR');
    expect(tv.video()).not.toBeNull();
  });
});

describe('Back on a note — "later": she reaches her films, and it waits on her home screen', () => {
  it('puts the note away to the home screen’s line, sends "later" and no reply, and does not bring it back by itself', async () => {
    const tv = await atHome();
    tv.card(NOTE);
    tv.advance(SETTLED_AFTER_MS);
    expect(shownType(tv)).toBe('MESSAGE');

    tv.advance(PRESS_SETTLE_MS);
    tv.press('Escape');

    expect(shownType(tv)).toBe(null);
    expect(tv.says()).toContain('A note from Sarah is waiting.');
    expect(tv.sentOf('card_action')).toEqual([{ t: 'card_action', cardId: 'note-1', action: 'later' }]);

    tv.advance(SETTLED_AFTER_MS * 2);
    expect(shownType(tv)).toBe(null);
  });

  it('takes a Back pressed in the note’s first second and does nothing with it', async () => {
    const tv = await atHome();
    tv.card(NOTE);
    tv.advance(SETTLED_AFTER_MS);
    tv.press('Escape');

    expect(shownType(tv)).toBe('MESSAGE');
    expect(tv.sentOf('card_action')).toEqual([]);
  });
});

describe('a film goes on from where she left it — watch/resume.ts, kept on this device', () => {
  const MIN = 60_000;

  it('starts again where she stopped it, not at 0:00, and keeps the place on this device', async () => {
    const tv = await atHome();
    const first = await watching(tv);
    at(tv, first, 4 * MIN);
    tv.press('Escape');
    expect(JSON.parse(tv.device.get('wick_tv_film_positions')!)).toEqual({ [BUNNY.id]: 4 * MIN });

    const again = await watching(tv);
    expect(again.currentTime).toBe(240);
  });

  it('comes back as it was left, on this device', async () => {
    const tv = await atHome({ stored: { wick_tv_film_positions: JSON.stringify({ [BUNNY.id]: 3 * MIN }) } });
    expect((await watching(tv)).currentTime).toBe(180);
  });

  it('starts from the beginning a film she watched to the credits, or had barely begun', async () => {
    const tv = await atHome();
    const first = await watching(tv);
    at(tv, first, BUNNY.creditsPositionMs! + 1000);
    tv.press('Escape');
    expect((await watching(tv)).currentTime).toBe(0);
  });
});

describe('Easier to see — larger text and higher contrast, kept on this device', () => {
  async function opened(opts: Parameters<typeof tvPage>[0] = {}) {
    const tv = await atHome(opts);
    tv.press('ArrowDown');
    expect(tv.focused()?.dataset.key).toBe('easier');
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    return tv;
  }

  it('opens a card of three items, never four: “Larger text”, “Higher contrast” and “Back”', async () => {
    const tv = await opened();
    expect(tv.buttons()).toEqual(['Larger text', 'Higher contrast', 'Back']);
  });

  it('sets every size a quarter larger, and black and white with the thicker ring, and keeps both on this device', async () => {
    const tv = await opened();
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    expect(tv.screen.classList.contains('larger-text')).toBe(true);
    tv.press('ArrowRight');
    tv.press('Enter');
    expect(tv.screen.classList.contains('higher-contrast')).toBe(true);
    expect(JSON.parse(tv.device.get('wick_tv_easier_to_see')!)).toEqual({ larger: true, contrast: true });

    tv.press('Escape');
    expect(tv.says()[0]).toBe(WORDS.en['home.question']);
    expect(tv.focused()?.dataset.key).toBe('easier');
  });

  it('comes back as it was left, on this device', async () => {
    const tv = await atHome({ stored: { wick_tv_easier_to_see: JSON.stringify({ larger: true, contrast: false }) } });
    expect(tv.screen.classList.contains('larger-text')).toBe(true);
    expect(tv.screen.classList.contains('higher-contrast')).toBe(false);
  });

  it('works for as long as the page does when the browser will not keep it', async () => {
    const tv = await opened({ noLocalStorage: true });
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    expect(tv.screen.classList.contains('larger-text')).toBe(true);
  });

  it('keeps a note waiting behind it, and lets the door over it', async () => {
    const tv = await opened();
    tv.advance(SETTLED_AFTER_MS);
    tv.card(NOTE);
    expect(shownType(tv)).toBe(null);
    tv.card(DOOR());
    expect(shownType(tv)).toBe('DOOR');
  });
});

describe('the legend of the keys — the first time, and on the pairing screen; put away by hand only', () => {
  it('gives the remote its focus back when "Got it" is clicked with a mouse', async () => {
    const tv = await atHome();
    const close = tv.page.document.getElementById('tv-keys-close');
    close.focus();
    close.click();
    const at = tv.page.document.activeElement;
    expect(at).not.toBe(close);
    expect(tv.page.document.getElementById('tv-screen').contains(at)).toBe(true);
  });

  it('is shown the first time, stays until put away, and is not shown by itself again', async () => {
    const tv = await atHome();
    expect(tv.keysPanel.hidden).toBe(false);
    tv.advance(60 * 60_000);
    expect(tv.keysPanel.hidden).toBe(false);

    tv.page.document.getElementById('tv-keys-close').click();
    expect(tv.keysPanel.hidden).toBe(true);
    expect(tv.device.get('wick_tv_keys_seen')).toBe('1');

    const again = await atHome({ stored: { wick_tv_keys_seen: '1' } });
    expect(again.keysPanel.hidden).toBe(true);
    again.press('?');
    expect(again.keysPanel.hidden).toBe(false);
  });
});

/** A pointer going down, or up, on a node of the page (the remote beside the screen). */
function pointer(node: El, type: string): FakeEvent {
  const e = {
    type,
    target: node,
    button: 0,
    pointerId: 1,
    detail: 1,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.stopped = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  node.dispatch(e);
  return e;
}

const remoteButton = (tv: ReturnType<typeof tvPage>, name: string) => tv.page.document.getElementById('tv-remote-buttons').querySelector(`[data-remote="${name}"]`)!;
const holdLine = (tv: ReturnType<typeof tvPage>) => tv.page.document.getElementById('stage').querySelector('.tv-hold')!;
const bar = (tv: ReturnType<typeof tvPage>) => tv.screen.querySelector('.film-bar')!;
const wordsOf = (node: El) => node.all().map((n) => n.ownText).filter(Boolean);
/** Her day, for a home that says who she is (contracts today.ts). */
const TODAY = (() => {
  const start = Date.parse('2027-01-15T00:00:00Z');
  return { weekday: 4, day: 15, month: 0, name: 'Margaret', dayStart: start, dayEnd: start + 24 * 3_600_000, coming: [] };
})();

describe('what this page is — said outside her screen, always (DESIGN.md §7)', () => {
  it('says it is a stand-in for her Fire TV and that the keyboard is the remote, with a link to the keys', async () => {
    const tv = tvPage();
    const line = tv.page.document.getElementById('tv-standin');
    expect(line.textContent).toContain('A stand-in for her Fire TV, in your browser. The keyboard is the remote.');
    const link = line.querySelector('a')!;
    expect(link.textContent).toBe('See the keys');
    expect(link.href).toBe('#tv-keys');
  });

  it('names her once her home says who she is', async () => {
    const tv = await atHome();
    tv.home({ light: 'on', today: TODAY });
    expect(tv.page.document.getElementById('tv-standin').textContent).toContain('A stand-in for Margaret’s Fire TV, in your browser.');
  });

  it('shows the keys when the link is followed, even after they were put away', async () => {
    const tv = await atHome({ stored: { wick_tv_keys_seen: '1' } });
    expect(tv.keysPanel.hidden).toBe(true);
    tv.page.document.getElementById('tv-standin').querySelector('a')!.click();
    expect(tv.keysPanel.hidden).toBe(false);
  });
});

describe('the remote beside the screen — a mouse or a finger presses what the keys press', () => {
  it('has her remote’s six things, each a button with a label: the D-pad and OK, Back, Play/Pause, the two skips — and the keys', () => {
    const tv = tvPage();
    const buttons = tv.page.document.getElementById('tv-remote-buttons').querySelectorAll('button');
    expect(buttons.map((b) => b.dataset.remote)).toEqual(['up', 'left', 'ok', 'right', 'down', 'back', 'play', 'rewind', 'forward', 'keys']);
    for (const b of buttons) {
      expect(b.getAttribute('aria-label'), b.dataset.remote).toMatch(/\w/);
      // An icon beside a word, or a label of its own: never an icon alone (DESIGN.md §5).
      expect(b.querySelectorAll('svg').every((svg) => svg.getAttribute('aria-hidden') === 'true')).toBe(true);
    }
  });

  it('moves the ring with the arrows and presses OK, exactly as the keys do', async () => {
    const tv = await atHome();
    remoteButton(tv, 'down').click();
    expect(tv.focused()?.dataset.key).toBe('easier');
    tv.advance(PRESS_SETTLE_MS);
    pointer(remoteButton(tv, 'ok'), 'pointerdown');
    pointer(remoteButton(tv, 'ok'), 'pointerup');
    expect(tv.buttons()).toEqual(['Larger text', 'Higher contrast', 'Back']);
    remoteButton(tv, 'back').click();
    expect(tv.says()[0]).toBe(WORDS.en['home.question']);
  });

  it('keeps the browser’s focus off its own buttons: the ring stays on her screen', async () => {
    const tv = await atHome();
    const down = pointer(remoteButton(tv, 'down'), 'pointerdown');
    expect(down.defaultPrevented).toBe(true);
  });

  it('holds OK with a finger: a line fills from 0.4 s and says what holding does, and at two seconds the offer is asked for', async () => {
    const tv = await atHome();
    const ok = remoteButton(tv, 'ok');
    pointer(ok, 'pointerdown');
    tv.advance(300);
    expect(holdLine(tv).hidden).toBe(true);
    tv.advance(200);
    expect(holdLine(tv).hidden).toBe(false);
    expect(wordsOf(holdLine(tv))).toEqual([WORDS.en['hold.keepPlain']]);
    tv.advance(HOLD_MS - 500);
    expect(tv.sentOf('reach')).toHaveLength(1);
    expect(holdLine(tv).hidden).toBe(true);
    pointer(ok, 'pointerup');
    // A hold is not a press: no film was started under her finger.
    expect(tv.run('film')).toBe(null);
  });

  it('asks for nothing when the finger lets go before two seconds, or slides off', async () => {
    const tv = await atHome();
    const ok = remoteButton(tv, 'ok');
    pointer(ok, 'pointerdown');
    tv.advance(1500);
    pointer(ok, 'pointercancel');
    tv.advance(HOLD_MS);
    expect(tv.sentOf('reach')).toEqual([]);
    expect(holdLine(tv).hidden).toBe(true);
    expect(tv.run('film')).toBe(null);
  });

  it('skips the film thirty seconds back and forward with the two skip keys, and says where it is', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    at(tv, video, 120_000);
    remoteButton(tv, 'forward').click();
    expect(video.currentTime).toBe(150);
    expect(bar(tv).hidden).toBe(false);
    remoteButton(tv, 'rewind').click();
    expect(video.currentTime).toBe(120);
    remoteButton(tv, 'play').click();
    expect(video.paused).toBe(true);
  });
});

describe('the film’s bar — its title, the time gone, how long is left (watch/transport.ts)', () => {
  it('comes on ↑ or ↓, and goes after four seconds of play', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    at(tv, video, 65_000);
    expect(bar(tv).hidden).toBe(true);

    tv.press('ArrowUp');
    expect(bar(tv).hidden).toBe(false);
    const total = BUNNY.durationMs;
    const left = Math.ceil((total - 65_000) / 60_000);
    expect(wordsOf(bar(tv))).toEqual([BUNNY.title, `1:05 of ${Math.floor(total / 60_000)}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}`, `${left} min left`]);
    expect(bar(tv).getAttribute('aria-label')).toBe(`${BUNNY.title}. 1:05 of ${Math.floor(total / 60_000)}:${String(Math.floor(total / 1000) % 60).padStart(2, '0')}. ${left} minutes left.`);

    tv.advance(4000);
    expect(bar(tv).hidden).toBe(true);
    tv.press('ArrowDown');
    expect(bar(tv).hidden).toBe(false);
  });

  it('stays while the film is paused, and comes on a skip', async () => {
    const tv = await atHome();
    const video = await watching(tv);
    tv.press('Enter');
    expect(video.paused).toBe(true);
    tv.advance(30_000);
    expect(bar(tv).hidden).toBe(false);
    tv.press('Enter');
    tv.advance(5000);
    expect(bar(tv).hidden).toBe(true);
    tv.press('ArrowLeft');
    expect(bar(tv).hidden).toBe(false);
  });

  it('never covers a card', async () => {
    const tv = await atHome();
    await watching(tv);
    tv.press('Enter');
    expect(bar(tv).hidden).toBe(false);
    tv.card(DOOR());
    expect(bar(tv).hidden).toBe(true);
  });
});

describe('her films in her order — home/order.ts, counted on this device and sent nowhere', () => {
  const [first, second, third] = CATALOG.programmes;

  it('puts a film she left part-way first, with “Carry on”, how long is left, and a line of how far she got', async () => {
    const tv = await atHome({ stored: { wick_tv_film_positions: JSON.stringify({ [third!.id]: 600_000 }) } });
    const tiles = tv.screen.querySelectorAll('.home-tile');
    expect(tiles.map((t) => t.dataset.key)).toEqual([third, first, second].map((p) => `programme:${p!.id}`));
    const minutes = Math.ceil((third!.durationMs - 600_000) / 60_000);
    expect(tv.says()).toContain(WORDS.en['home.carryOn']);
    expect(tv.says()).toContain(`${minutes} min left`);
    expect(tiles[0]!.querySelector('.home-chip')!.textContent).toBe(WORDS.en['home.carryOn']);
    expect(tiles[0]!.getAttribute('aria-label')).toBe(`${third!.title}. Carry on where you left it, ${minutes} minutes left.`);
    expect(tiles[0]!.querySelector('.home-progress-fill')!.style['--fill']).toBe(String(600_000 / third!.durationMs));
    expect(tiles[1]!.querySelector('.home-progress')).toBe(null);
  });

  it('then the films she starts most at this time of day', async () => {
    const tally = { [second!.id]: { morning: 2, afternoon: 2, evening: 2 } };
    const tv = await atHome({ stored: { wick_tv_watch_tally: JSON.stringify(tally) } });
    expect(tv.screen.querySelectorAll('.home-tile').map((t) => t.dataset.key)).toEqual([second, first, third].map((p) => `programme:${p!.id}`));
  });

  it('counts a film she starts on this device, and tells nobody', async () => {
    const tv = await atHome();
    await watching(tv);
    const tally = JSON.parse(tv.device.get('wick_tv_watch_tally')!) as Record<string, Record<string, number>>;
    expect(Object.values(tally[first!.id]!)).toEqual([1]);
    expect(JSON.stringify(tv.sent())).not.toContain('morning');
  });
});

describe('How Wick works — a tour of examples, with the remote alone, and nothing sent (tour/tour.ts)', () => {
  async function onTheTour() {
    const tv = await atHome();
    tv.press('ArrowDown');
    tv.press('ArrowRight');
    expect(tv.focused()?.dataset.key).toBe('tour');
    expect(tv.focused()?.getAttribute('aria-label')).toBe(WORDS.en['home.tourLabel']);
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Enter');
    return tv;
  }
  const noted = (tv: ReturnType<typeof tvPage>) => tv.sent().filter((e) => !['break_state', 'home'].includes(String(e.t)));

  it('shows each thing Wick does as an example, the door first with the stand-in doorbell’s picture from this page', async () => {
    const tv = await onTheTour();
    expect(tv.says()).toEqual([
      'How Wick works · 1 of 5',
      WORDS.en['tour.example'],
      WORDS.en['tour.doorHeadline'],
      WORDS.en['tour.doorPicture'],
      WORDS.en['tour.doorDetail'].replace('{name}', WORDS.en['tour.family']),
      WORDS.en['tour.next'],
      WORDS.en['tour.close'],
    ]);
    expect(tv.screen.querySelector('.tour-picture')!.src).toBe('parcel.jpg');
    expect(tv.focused()?.dataset.key).toBe('tour-next');
  });

  it('goes from step to step with OK, ends on the films, and sends nothing at all', async () => {
    const tv = await onTheTour();
    const before = noted(tv).length;
    const headlines = [];
    for (let step = 1; step <= 5; step++) {
      headlines.push(tv.screen.querySelector('.headline')!.textContent);
      tv.advance(PRESS_SETTLE_MS);
      tv.press('Enter');
    }
    expect(headlines).toEqual([
      WORDS.en['tour.doorHeadline'],
      WORDS.en['tour.noteHeadline'].replace('{name}', WORDS.en['tour.family']),
      WORDS.en['tour.holdHeadline'],
      WORDS.en['tour.readHeadline'],
      WORDS.en['tour.doneHeadline'],
    ]);
    expect(tv.says()[0]).toBe(WORDS.en['home.question']);
    expect(tv.focused()?.dataset.key).toBe('tour');
    expect(noted(tv).slice(before)).toEqual([]);
  });

  it('closes with Back, holds nothing, reads nothing, and lets the door over it while a note waits behind it', async () => {
    const tv = await onTheTour();
    tv.keyDown('Enter');
    tv.advance(HOLD_MS + 100);
    tv.keyUp('Enter');
    // Holding OK is nothing here: let go, it is the press of the button it is on, "Show me the next".
    expect(tv.sentOf('reach')).toEqual([]);
    expect(tv.says()[0]).toBe('How Wick works · 2 of 5');
    tv.press(' ');
    expect(tv.sentOf('read')).toEqual([]);

    tv.advance(SETTLED_AFTER_MS);
    tv.card(NOTE);
    expect(shownType(tv)).toBe(null);
    tv.card(DOOR());
    expect(shownType(tv)).toBe('DOOR');
    tv.advance(PRESS_SETTLE_MS);
    tv.press('Escape');
    expect(tv.says()[0]).toBe('How Wick works · 2 of 5');
    // Back closes the tour, and the note that waited behind it comes now, on her home screen.
    tv.press('Escape');
    expect(shownType(tv)).toBe('MESSAGE');
  });
});

describe('the mark that reads a card aloud — the speaker and its words (read.chip)', () => {
  it('carries the speaker icon and “Read aloud”, and is not one of the card’s buttons', async () => {
    const tv = await atHome();
    tv.advance(SETTLED_AFTER_MS);
    tv.card(NOTE);
    const mark = tv.screen.querySelector('.tv-read')!;
    expect(mark.dataset.chip).toBe(WORDS.en['read.chip']);
    expect(mark.querySelector('svg')).not.toBe(null);
    expect(mark.tagName).toBe('span');
  });
});

describe('tv.css — the television’s floor', () => {
  const css = readFileSync(fileURLToPath(new URL('../tv.css', import.meta.url)), 'utf8');
  /** Everything but the legend, which is for whoever is trying the page and not part of her television. */
  const screenCss = css.slice(0, css.indexOf('/* --- The keys (tv.html)'));
  const tokens = (block: string) => Object.fromEntries([...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [m[1]!, m[2]!]));
  /** The rule whose selectors start with this one (the screen's tokens are shared with the hold line drawn over it). */
  const rule = (selector: string) => new RegExp(`(?:^|\\n)${selector.replace(/\./g, '\\.')}(?:,\\s*[^{]+)? \\{([^}]*)\\}`).exec(css)![1]!;
  const ordinary = tokens(rule('.tv-screen'));
  const high = tokens(rule('.tv-screen.higher-contrast'));

  it('is the calm-ui palette', () => {
    expect(ordinary).toMatchObject({ ink: palette.ink.toLowerCase(), 'ink-dim': palette.inkDim.toLowerCase(), ground: palette.ground.toLowerCase(), raised: palette.raised.toLowerCase(), accent: palette.accent.toLowerCase(), focus: palette.focus.toLowerCase() });
  });

  it('sets no type under 32, a quarter larger with Larger text', () => {
    expect(css).toMatch(new RegExp(`--body: calc\\(${calmType.bodyPt} \\* var\\(--dp\\) \\* var\\(--type\\)\\)`));
    expect(rule('.tv-screen.larger-text')).toMatch(/^\s*--type: 1\.25;/);
    for (const [, value] of screenCss.matchAll(/font-size:\s*([^;]+);/g)) expect(value).toMatch(/^var\(--(body|headline|display)\)$/);
  });

  it('keeps every word at 7:1 or more, and at 15:1 or more with Higher contrast, with a thicker ring', () => {
    for (const [fg, bg] of [['ink', 'raised'], ['ink-dim', 'raised'], ['ink', 'ground'], ['ink-dim', 'ground'], ['on-accent', 'accent']]) {
      expect(contrastRatio(ordinary[fg]!, ordinary[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(high[fg]!, high[bg]!), `${fg} on ${bg}, higher contrast`).toBeGreaterThanOrEqual(15);
    }
    expect(rule('.tv-screen.higher-contrast')).toMatch(/--ring: calc\(8 \* var\(--dp\)\)/);
    expect(rule('.tv-screen')).toMatch(/--ring: calc\(4 \* var\(--dp\)\)/);
  });

  /** The blocks that apply only when reduced motion has not been asked for, and the stylesheet without them. */
  const motionBlocks: string[] = [];
  let still = css;
  for (let at = still.indexOf('@media (prefers-reduced-motion: no-preference)'); at >= 0; at = still.indexOf('@media (prefers-reduced-motion: no-preference)')) {
    let depth = 0;
    let end = still.indexOf('{', at);
    for (; end < still.length; end++) {
      if (still[end] === '{') depth++;
      if (still[end] === '}' && --depth === 0) break;
    }
    motionBlocks.push(still.slice(at, end + 1));
    still = still.slice(0, at) + still.slice(end + 1);
  }

  it('has no red anywhere, and nothing that moves by itself', () => {
    for (const [hex] of css.matchAll(/#[0-9a-f]{6}\b/gi)) expect(alarmHue(hex), hex).toBe(null);
    expect(css).not.toMatch(/animation|@keyframes/);
  });

  it('moves only what a press moves, in 200 ms or less, and nothing at all with reduced motion asked for (DESIGN.md §4)', () => {
    expect(motionBlocks.length).toBeGreaterThan(0);
    expect(still).not.toMatch(/transition/);
    for (const block of motionBlocks) for (const [, ms] of block.matchAll(/(\d+)ms/g)) expect(Number(ms)).toBeLessThanOrEqual(200);
  });

  it('has the redesign’s three: the raised-high surface, the progress track and the scrim — and every word on them at 7:1', () => {
    expect(ordinary).toMatchObject({ 'raised-high': '#2a2621', track: '#4a443b' });
    expect(rule('.tv-screen')).toMatch(/--scrim: rgb\(18 16 14 \/ 82%\);/);
    for (const [fg, bg] of [['ink', 'raised-high'], ['ink-dim', 'raised-high'], ['accent', 'raised'], ['accent', 'raised-high']]) {
      expect(contrastRatio(ordinary[fg]!, ordinary[bg]!), `${fg} on ${bg}`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio(high[fg]!, high[bg]!), `${fg} on ${bg}, higher contrast`).toBeGreaterThanOrEqual(15);
    }
  });

  it('shows the focus on a film as the ring, a raised surface and a little larger — never a colour alone', () => {
    const focused = rule('.home-tile:focus');
    expect(focused).toMatch(/background: var\(--raised-high\);/);
    expect(focused).toMatch(/transform: scale\(1\.04\);/);
    expect(css).toMatch(/\.tv-screen button:focus,\n\.tv-screen \[data-focusable\]:focus \{\s*outline: var\(--ring\) solid var\(--focus\);/);
  });

  it('sets her words in Atkinson Hyperlegible Next, from this page’s own files, and the page around her screen at 14 px or more', () => {
    expect(css).toMatch(/--font: 'Atkinson Hyperlegible Next Variable'/);
    expect(rule('.room')).toMatch(/font-size: clamp\(14px,/);
    for (const [, value] of css.slice(css.indexOf('/* --- The keys (tv.html)')).matchAll(/font-size:\s*([^;]+);/g)) expect(value, value).toMatch(/^(clamp\(14px,|max\(14px,)/);
  });
});

describe('tv.js — what it never does', () => {
  it('starts no reading by itself: only Play, or the mark on the card, asks for one', () => {
    expect(TV_SOURCE.match(/toggleRead\(\)/g)).toHaveLength(1);
    expect(TV_SOURCE).toMatch(/function pressPlay\(\)/);
  });

  it('puts nothing away on a timer: its only timers are the look and a code tried again (the channel tries itself again)', () => {
    expect(TV_SOURCE.match(/setTimeout\(/g) ?? []).toHaveLength(0);
    expect(TV_SOURCE.match(/setInterval\(/g)).toHaveLength(1);
  });
});

describe('she stops Wick from this television', () => {
  const SURE = queued({
    id: 'sharing',
    type: 'SHARING',
    page: 5,
    pages: 5,
    headline: 'Delete everything Wick keeps about your home?',
    detail: 'This cannot be undone.',
    actions: [
      { id: 'keep_wick', label: 'Keep Wick', kind: 'primary' },
      { id: 'stop_yes', label: 'Yes, delete everything', kind: 'secondary' },
    ],
  });

  async function onTheQuestion() {
    const tv = await atHome();
    tv.card(SURE);
    tv.advance(SETTLED_AFTER_MS);
    expect(shownType(tv)).toBe('SHARING');
    tv.advance(PRESS_SETTLE_MS);
    tv.press('ArrowRight');
    tv.press('Enter');
    return tv;
  }

  it('asks the Wick server itself, in words, and sends no card action for it', async () => {
    const tv = await onTheQuestion();

    const stop = tv.asked.find((a) => a.url.endsWith('/tv/stop'))!;
    expect(stop).toBeDefined();
    expect(stop.method).toBe('POST');
    expect(stop.body).toEqual({ confirm: 'stop' });
    expect(tv.sentOf('card_action')).toEqual([]);
  });

  it('is no longer this home’s television once her home is closed, and stays on the question if it was not', async () => {
    const refused = await onTheQuestion();
    refused.asked.find((a) => a.url.endsWith('/tv/stop'))!.answer(502, { error: 'doorbell_unavailable' });
    await refused.settle();
    expect(shownType(refused)).toBe('SHARING');
    expect(refused.tab.get('wick_virtual_television')).toBeDefined();

    const stopped = await onTheQuestion();
    stopped.asked.find((a) => a.url.endsWith('/tv/stop'))!.answer(200, { stopped: true });
    await stopped.settle();
    expect(stopped.tab.get('wick_virtual_television')).toBeUndefined();
  });
});

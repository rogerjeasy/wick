/**
 * The mantelpiece's two screens and the app that puts them up. None of
 * them is rendered here — no view in this app is — so what they decide is
 * in mantel.ts and idle.ts, tested there, and this holds the views to
 * using exactly that: read as source, the way family/__tests__/apart.test.ts
 * reads the app.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { layout, motion, type } from '../../../../../packages/vega-calm-ui/src/tokens.js';
import { cardHeightDp } from '../../../../../packages/vega-calm-ui/src/constraints.js';
import { MANTEL_PICTURE_AREA } from '../mantelLayout.js';

const read = (file: string): string => readFileSync(fileURLToPath(new URL(file, import.meta.url)), 'utf8');
/** A file's code without its comments: what it does, not what it says it does not do. */
const code = (file: string): string => read(file).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');

describe('the mantelpiece — one picture, as large as the screen allows', () => {
  it('gives the picture the whole screen but its margins and the one line under it', () => {
    const line = type.bodyPt * layout.lineHeight.body;

    expect(MANTEL_PICTURE_AREA).toEqual({ width: 864, height: 419 });
    expect(MANTEL_PICTURE_AREA.width).toBe(960 - 2 * 48);
    expect(MANTEL_PICTURE_AREA.height).toBe(Math.floor(layout.screenHeightDp - 2 * layout.screenMarginDp - 12 - line));
  });

  it('has room for the choice over it: the card that asks is no taller than the screen allows', () => {
    expect(cardHeightDp({ compact: true, detailLines: 1 })).toBeLessThanOrEqual(layout.screenHeightDp - 2 * layout.screenMarginDp);
  });
});

describe('MantelScreen.tsx', () => {
  const screen = code('../MantelScreen.tsx');

  it('decides nothing itself: every key goes through the viewer (mantel.ts), and what comes back is done', () => {
    expect(screen).toMatch(/viewer\(current\.current, event\)/);
    for (const effect of ["'close'", "'ask'", "'take_down'"]) expect(screen).toContain(effect);
    expect(screen).toMatch(/run\(\{ t: 'mantel', mantel \}\)/);
  });

  it('moves between pictures on Left and Right going down, and not while a card or the door has the remote', () => {
    expect(screen).toMatch(/useTVEventHandler\(/);
    expect(screen).toMatch(/if \(latest\.current\.cardVisible\) return;/);
    expect(screen).toMatch(/event\.eventType === 'left'[\s\S]{0,80}run\(\{ t: 'move', by: -1 \}\)/);
    expect(screen).toMatch(/event\.eventType === 'right'[\s\S]{0,80}run\(\{ t: 'move', by: 1 \}\)/);
  });

  it('holds the focus on the picture — Android gives a key to nothing when nothing is focused — and gives it up to the choice, or to a card', () => {
    expect(screen).toMatch(/focusable=\{!cardVisible && !state\.choosing\}/);
    expect(screen).toMatch(/hasTVPreferredFocus=\{!cardVisible && !state\.choosing\}/);
    expect(screen).toMatch(/onPress=\{\(\) => run\(\{ t: 'ok' \}\)\}/);
  });

  it('keeps the hold for Sarah on the picture, as on everything on the home screen', () => {
    expect(screen).toMatch(/onLongPress=\{onHold\}/);
    expect(screen).toMatch(/delayLongPress=\{HOLD_MS\}/);
    expect(screen).toMatch(/onPressOut=\{onKeyUp\}/);
  });

  it('offers "Leave it" first, so it has the focus, and "Take it down" second', () => {
    const choice = screen.slice(screen.indexOf('const choice ='), screen.indexOf('];', screen.indexOf('const choice =')));

    expect(choice.indexOf("id: 'leave'")).toBeGreaterThan(-1);
    expect(choice.indexOf("id: 'leave'")).toBeLessThan(choice.indexOf("id: 'take_down'"));
    expect(choice).toMatch(/id: 'leave', label: say\('mantel\.leave'\), kind: 'primary'/);
    expect(choice).toMatch(/id: 'take_down', label: say\('mantel\.takeDown'\), kind: 'secondary'/);
    // The card focuses its first button unless told otherwise, and it is not told otherwise.
    expect(screen).not.toMatch(/initialFocusId/);
    expect(screen).toMatch(/onAction=\{\(id\) => run\(\{ t: id === 'take_down' \? 'take_down' : 'leave' \}\)\}/);
  });

  it('takes Back for itself: the choice first, then the screen', () => {
    expect(screen).toMatch(/hardwareBackPress', \(\) => \{\s*run\(\{ t: 'back' \}\);\s*return true;/);
  });

  it('shows the picture whole, says who it is from and where it stands, and waits calmly with three dots', () => {
    expect(screen).toMatch(/<Picture\b/);
    expect(screen).toMatch(/say\('mantel\.from', \{ name: said\.fromName \}\)/);
    expect(screen).toMatch(/say\('mantel\.place', \{ place: said\.place, count: said\.count \}\)/);
    expect(screen).toMatch(/const WAITING = '…';/);
    expect(screen).toMatch(/onFailed=\{\(\) => run\(\{ t: 'failed', photoId: item\.photoId \}\)\}/);
  });

  it('has no timer: nothing on it changes by itself', () => {
    expect(screen).not.toMatch(/setTimeout|setInterval|Animated/);
  });
});

describe('IdleScreen.tsx', () => {
  const screen = code('../IdleScreen.tsx');

  it('holds the focus the whole time it is mounted — on, and while the key that ended it is still down — so no press reaches the home screen', () => {
    expect(screen).toMatch(/<Pressable\b[\s\S]*?focusable\b[\s\S]*?hasTVPreferredFocus\b/);
    // Nothing on it is pressed, held or chosen: it has no controls.
    expect(screen).not.toMatch(/onPress=|onLongPress=|onAction=/);
  });

  it('draws nothing once a key has ended it: the home screen shows through', () => {
    expect(screen).toMatch(/\{visible && item \? \(/);
  });

  it('has no words but, small, who the picture is from — and none in the picture’s place if it cannot be shown', () => {
    expect(screen).toMatch(/say\('mantel\.from', \{ name: item\.fromName \}\)/);
    expect(screen).toMatch(/wordless/);
    expect(screen.match(/say\(/g)).toHaveLength(2);
  });

  it('changes pictures with a fade no longer than the motion token allows — 200 ms — and has no timer of its own', () => {
    expect(motion.durationMs).toBe(200);
    expect(screen).toMatch(/duration: motion\.durationMs/);
    expect(screen).not.toMatch(/duration: \d/);
    expect(screen).not.toMatch(/setTimeout|setInterval/);
  });

  it('listens for no key itself: the app does, in one place', () => {
    expect(screen).not.toMatch(/useTVEventHandler|BackHandler/);
  });
});

describe('ResidentApp.tsx — the mantelpiece and the idle screen, in the app', () => {
  const app = code('../../ResidentApp.tsx');
  const tick = app.slice(app.indexOf('const tick = async'), app.indexOf('void tick();'));

  it('offers the mantelpiece on the home screen only when the home says she has kept something', () => {
    expect(app).toMatch(/mantel=\{offersMantel\(home\) \? say\('home\.mantel'\) : undefined\}/);
    expect(app).toMatch(/onOpenMantel=\{handleOpenMantel\}/);
  });

  it('asks the server when she opens it, and shows only what answers that opening or still loads', () => {
    expect(app).toMatch(/const handleOpenMantel = React\.useCallback\(\(\) => \{[\s\S]{0,120}askMantel\(\);/);
    expect(app).toMatch(/enqueueOutbound\(\{ t: 'mantel', at \}\)/);
    expect(app).toMatch(/mantelToShow\(mantel, mantelOpenedAt, Date\.now\(\)\)/);
  });

  it('tells the server what she took down, by the picture’s id and nothing else', () => {
    expect(app).toMatch(/enqueueOutbound\(\{ t: 'mantel_take_down', photoId, at: Date\.now\(\) \}\)/);
  });

  it('holds a note behind the mantelpiece and lets the door through — before anything is said to have been shown', () => {
    const picks = tick.indexOf('overMantel(breakController.pickCard(cards, now), on.mantelOpen)');

    expect(picks).toBeGreaterThan(-1);
    expect(tick.indexOf('breakController.noteShown(picked, cards, now)')).toBeGreaterThan(picks);
  });

  it('works the idle screen out in the one-second look, from the pure rule, with no timer of its own', () => {
    const look = tick.slice(tick.indexOf('lookAtIdle({'), tick.indexOf('});', tick.indexOf('lookAtIdle({')));

    // The home screen as the look found it — after the cards were picked, never before.
    expect(tick.indexOf('lookAtIdle({')).toBeGreaterThan(tick.indexOf('setCard(shown ?? null)'));
    for (const given of [
      'foreground: on.onScreen',
      'watching: on.watching',
      'mantelOpen: on.mantelOpen',
      'liveOpen: on.liveOpen',
      'cardShowing: shown !== undefined',
      'waiting: waitingCard !== undefined',
      'idle: idleNow.current',
      'lastActiveAt: lastActiveAt.current',
      'askedAt: mantelAskedAt.current',
      'failed: idleFailed.current.ids',
    ]) {
      expect(look, given).toContain(given);
    }
    expect(app.match(/setInterval\(/g)).toHaveLength(1);
    expect(app.match(/setTimeout\(/g)).toHaveLength(1);
  });

  it('does what the rule says and nothing more: moves on what the idle minutes are counted from, asks, and puts the screen up or down', () => {
    expect(tick).toMatch(/lastActiveAt\.current = seen\.lastActiveAt;/);
    expect(tick).toMatch(/if \(seen\.ask\) \{\s*mantelAskedAt\.current = now;\s*void store\.enqueueOutbound\(\{ t: 'mantel', at: now \}\);/);
    expect(tick).toMatch(/setIdle\(seen\.idle\)/);
    expect(tick).toMatch(/setIdleItem\(seen\.picture\)/);
  });

  it('hears every key in one place, and starts, opens and sends nothing from one: the idle rule, the time of the last key, and Play for the reader', () => {
    const handler = app.slice(app.indexOf('useTVEventHandler((event) => {'), app.indexOf('\n  });', app.indexOf('useTVEventHandler((event) => {')));

    expect(handler).toMatch(/lastActiveAt\.current = now;/);
    expect(handler).toMatch(/idleOnKey\(idleNow\.current, event, now\)/);
    // Nothing is started, opened or sent from a key seen here.
    expect(handler).not.toMatch(/enqueueOutbound|setWatching|setCard|handle[A-Z]/);
  });

  it('keeps the home screen out of the remote’s reach while a card, the mantelpiece or the idle screen has it', () => {
    // By the one rule for the home behind whatever is over it (home/behind.ts, tested in home/__tests__/behind.test.ts).
    expect(app).toMatch(/const behind = homeBehind\(\{ card: card !== null, mantelOpen, idle \}\);/);
    expect(app).toMatch(/cardVisible=\{!behind\.reach\}/);
  });

  it('ends the idle screen on Back without leaving Wick', () => {
    expect(app).toMatch(/const back = idleOnBack\(idleNow\.current\);[\s\S]{0,200}if \(back\.consumed\)[\s\S]{0,120}return true;/);
  });

  it('mounts the idle screen while it is on and while the key that ended it is still down, and shows it only while it is on', () => {
    expect(app).toMatch(/\{blocksHome\(idle\) \? \(\s*<IdleScreen\b/);
    expect(app).toMatch(/visible=\{idle\.phase === 'on'\}/);
  });

  it('tells the break engine a card was answered, so one sent back under the same id is shown as a new showing', () => {
    expect(app).toMatch(/breakController\.answered\(cardId\);/);
  });

  it('asks for its cards again when a picture card’s address has run out — through the channel it holds, and not for ever', () => {
    expect(app).toMatch(/cardChannel\.current = held;/);
    expect(app).toMatch(/if \(pictureRefresh\.due\(cardId, Date\.now\(\)\)\) cardChannel\.current\?\.reconcile\(\);/);
    expect(app).toMatch(/onPictureFailed=\{handlePictureFailed\}/);
  });

  it('draws the door card over the mantelpiece, and the mantelpiece over the home screen', () => {
    expect(app.indexOf('<MantelScreen')).toBeGreaterThan(app.indexOf('<HomeScreen'));
    expect(app.indexOf('<CardRenderer')).toBeGreaterThan(app.indexOf('<MantelScreen'));
    expect(app.indexOf('<IdleScreen')).toBeGreaterThan(app.indexOf('<HomeScreen'));
  });
});

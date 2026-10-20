/**
 * The home screen, drawn (home/HomeScreen.tsx) — by React's own
 * reconciler, over the platform stood in for in src/__tests__/render.
 *
 * What is checked is what she meets: the question and the three films, the
 * quiet line and the pills when there is something to say, where the focus
 * starts and where it goes back to, that a press in the home's first second
 * back — or one whose key went down somewhere else — starts nothing, that
 * nothing of it can be reached while a card is up, and that every word is
 * at the floor and legible in each Easier to see setting.
 *
 * The clock is the only thing faked: the screen reads `Date.now()` for its
 * one second (press/settle.ts) and its memory of the focus
 * (home/focusMemory.ts), and the test says what time it is.
 */
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CalmPreferencesProvider, calmTheme, type CalmPreferences } from '@wick/vega-calm-ui';
import type { HouseholdLanguage } from '@wick/contracts';
import { CATALOG, type Programme } from '../../catalog/catalog.js';
import { HOLD_MS } from '../../watch/hold.js';
import { HomeScreen, type HomeScreenProps } from '../HomeScreen.js';
import { HOME_RING_DP } from '../homeLayout.js';
import { all, button, buttons, named, contrastOf, flat, focus, fontSize, headers, preferred, press, pressOk, render, settle, texts, type Drawn, type Node } from '../../__tests__/render/render.js';

vi.mock('@amazon-devices/react-native-kepler', () => import('../../__tests__/render/platform.js'));
vi.mock('../../icons/iconSources.generated.js', () => import('../../__tests__/render/icons.js'));
// The films' stills are `require`d images, which only the Vega bundler resolves: here each is its own address.
vi.mock('../posters.js', () => ({
  POSTERS: { 'big-buck-bunny': { uri: 'poster:big-buck-bunny' }, sintel: { uri: 'poster:sintel' }, 'tears-of-steel': { uri: 'poster:tears-of-steel' } },
}));

const T = 1_800_000_000_000;
const STANDARD: CalmPreferences = { largerText: false, higherContrast: false };
const [BUNNY, SINTEL, TEARS] = CATALOG as [Programme, Programme, Programme];

beforeEach(() => {
  // Only the clock: React's own scheduling and `act` keep their real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T);
});
afterEach(() => {
  vi.useRealTimers();
});

type Props = Partial<HomeScreenProps>;

function screen(props: Props = {}, preferences: CalmPreferences = STANDARD): React.JSX.Element {
  const all: HomeScreenProps = {
    drawn: true,
    inFront: true,
    language: 'en',
    programmes: CATALOG,
    onChoose: () => undefined,
    cardVisible: false,
    seeing: 'Easier to see',
    ...props,
  };
  return (
    <CalmPreferencesProvider preferences={preferences}>
      <HomeScreen {...all} />
    </CalmPreferencesProvider>
  );
}

async function home(props: Props = {}, preferences: CalmPreferences = STANDARD): Promise<Drawn & { redraw(next: Props): Promise<void> }> {
  let current = props;
  const drawn = await render(screen(current, preferences));
  return Object.assign(drawn, {
    redraw: async (next: Props) => {
      current = { ...current, ...next };
      await drawn.update(screen(current, preferences));
    },
  });
}

const at = (ms: number): void => {
  vi.setSystemTime(T + ms);
};
const tile = (root: Node, programme: Programme, language: HouseholdLanguage = 'en'): Node =>
  button(root, `${programme.title}. ${language === 'en' ? programme.line : `${Math.round(programme.durationMs / 60_000)} minutos`}`);
const WITH_EVERYTHING: Props = { light: 'Light on', mantel: 'Mantelpiece', waiting: 'A note from Sarah is waiting.' };

describe('what she sees', () => {
  it('asks what she would like to watch, as a header, and offers the three films, each with its picture', async () => {
    const { root } = await home();

    expect(headers(root).map((h) => h.children.join(''))).toEqual(['What would you like to watch?']);
    for (const programme of CATALOG) {
      const t = tile(root, programme);
      expect(t.props.accessibilityRole).toBe('button');
      expect(all(t, 'Image').map((i) => i.props.source)).toEqual([{ uri: `poster:${programme.id}` }]);
      expect(texts(t)).toEqual([programme.title]);
    }
    // And nothing else to press but Easier to see.
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual([
      'Big Buck Bunny. 10 minutes',
      'Sintel. 15 minutes',
      'Tears of Steel. 12 minutes',
      'Easier to see. Press OK for larger text or higher contrast.',
    ]);
  });

  it('asks it in Spanish when that is her language, and says how long each film runs in Spanish', async () => {
    const { root } = await home({ language: 'es', seeing: 'Más fácil de ver', waiting: 'Hay una nota de Sarah esperando.' });

    expect(headers(root).map((h) => h.children.join(''))).toEqual(['¿Qué le gustaría ver?']);
    expect(named(tile(root, SINTEL, 'es'))).toBe('Sintel. 15 minutos');
    expect(texts(root)).toContain('Abrir');
    expect(buttons(root).map(named).slice(3)).toEqual(['Hay una nota de Sarah esperando. Presione OK para abrir.', 'Más fácil de ver. Presione OK para letra más grande o más contraste.']);
  });

  it('has the question alone in its row, the quiet line under the films, and the pills in their own row: light, mantelpiece, Easier to see', async () => {
    const { root } = await home(WITH_EVERYTHING);
    const labels = buttons(root).map((b) => String(b.props.accessibilityLabel));

    expect(labels).toEqual([
      'Big Buck Bunny. 10 minutes',
      'Sintel. 15 minutes',
      'Tears of Steel. 12 minutes',
      'A note from Sarah is waiting. Press OK to open it.',
      'Your light in the window. Light on. Press OK to see who can see it.',
      'Your mantelpiece. Press OK to see the pictures you have kept.',
      'Easier to see. Press OK for larger text or higher contrast.',
    ]);
    // The title row holds the question and nothing to press.
    const question = headers(root)[0]!;
    expect(buttons(question.parent!).length).toBe(0);
    // The waiting line says what OK does, and the pills say their two words.
    expect(texts(button(root, labels[3]!))).toEqual(['A note from Sarah is waiting.', 'Open']);
    expect(texts(button(root, labels[4]!))).toEqual(['Light on']);
    expect(texts(button(root, labels[5]!))).toEqual(['Mantelpiece']);
  });

  it('has the mantelpiece only when she has kept something, the light only when someone can see it, and Easier to see always', async () => {
    const without = await home();
    expect(texts(without.root)).not.toContain('Mantelpiece');
    expect(texts(without.root)).not.toContain('Light on');
    expect(texts(without.root)).toContain('Easier to see');
  });

  it('says who looked in where the waiting line goes, as something to read with nothing to press — and a waiting card comes first', async () => {
    const drawn = await home({ lookedIn: 'Sarah looked in this morning.' });
    expect(texts(drawn.root)).toContain('Sarah looked in this morning.');
    expect(buttons(drawn.root).some((b) => String(b.props.accessibilityLabel).includes('looked in'))).toBe(false);

    await drawn.redraw({ waiting: 'Your week is ready to read.' });
    expect(texts(drawn.root)).not.toContain('Sarah looked in this morning.');
    expect(texts(drawn.root)).toContain('Your week is ready to read.');
  });

  it('makes the films’ pictures shorter for the quiet line, so the screen still fits', async () => {
    const posterHeight = async (props: Props): Promise<number> => flat(all((await home(props)).root, 'Image')[0]!.props.style).height as number;

    expect(await posterHeight({ waiting: 'Your week is ready to read.' })).toBeLessThan(await posterHeight({}));
    expect(await posterHeight({ lookedIn: 'Sarah looked in this morning.' })).toBeLessThan(await posterHeight({}));
    expect(await posterHeight({ light: 'Light on', mantel: 'Mantelpiece' })).toBe(await posterHeight({}));
  });
});

describe.each([
  ['standard', { largerText: false, higherContrast: false }],
  ['larger text', { largerText: true, higherContrast: false }],
  ['higher contrast', { largerText: false, higherContrast: true }],
  ['larger text and higher contrast', { largerText: true, higherContrast: true }],
] as const)('drawn with %s', (_name, preferences) => {
  it('sets every word at the floor or above, legible on what it is written on', async () => {
    const { root } = await home({ ...WITH_EVERYTHING }, preferences);
    const floor = preferences.largerText ? 40 : 32;
    const ratio = preferences.higherContrast ? 15 : 7;

    for (const text of all(root, 'Text')) {
      expect(fontSize(text), text.children.join('')).toBeGreaterThanOrEqual(floor);
      expect(contrastOf(text), text.children.join('')).toBeGreaterThanOrEqual(ratio);
    }
  });

  it('shows the focus as a ring that takes the same room at rest, thicker with higher contrast on', async () => {
    const { root } = await home({ ...WITH_EVERYTHING }, preferences);
    for (const b of buttons(root)) {
      const rest = flat(b.props.style, { focused: false });
      const on = flat(b.props.style, { focused: true });
      // A ring where there was none — or, with higher contrast on, where every button is outlined in white at rest, a thicker one.
      expect(on.borderColor !== rest.borderColor || (on.borderWidth as number) > (rest.borderWidth as number)).toBe(true);
      expect((rest.borderWidth as number) + ((rest.margin as number | undefined) ?? 0)).toBe((on.borderWidth as number) + ((on.margin as number | undefined) ?? 0));
      expect(on.borderWidth).toBe(calmTheme(preferences).ring(HOME_RING_DP).focused.borderWidth);
      expect(on.borderWidth).toBeGreaterThan(preferences.higherContrast ? HOME_RING_DP : 0);
    }
  });
});

const DAY = {
  greeting: 'Good morning, Margaret.',
  greetingPlain: 'Good morning.',
  date: 'Monday 19 October',
  coming: ['Maria usually comes tomorrow at 9 am.'],
};

describe('her day, at the top (home/herDay.ts)', () => {
  it('greets her by name in place of the question, with the date beside it and who is coming under it', async () => {
    const { root } = await home({ day: DAY });

    expect(headers(root).map((h) => h.children.join(''))).toEqual(['Good morning, Margaret.']);
    expect(texts(root)).toContain('Monday 19 October');
    expect(texts(root)).toContain('Maria usually comes tomorrow at 9 am.');
    expect(texts(root)).not.toContain('What would you like to watch?');
    // At the floor size the films keep their pictures.
    for (const programme of CATALOG) expect(all(tile(root, programme), 'Image')).toHaveLength(1);
  });

  it('is read, never pressed: nothing new takes the focus, and the focus still starts on the first film', async () => {
    const { root } = await home({ day: DAY });
    expect(buttons(root).map((b) => b.props.accessibilityLabel)).toEqual([
      'Big Buck Bunny. 10 minutes',
      'Sintel. 15 minutes',
      'Tears of Steel. 12 minutes',
      'Easier to see. Press OK for larger text or higher contrast.',
    ]);
    expect(preferred(root)).toEqual(['Big Buck Bunny. 10 minutes']);
  });

  it('sets every word of it at the floor or above, legible on what it is written on, in each Easier to see setting', async () => {
    for (const preferences of [STANDARD, { largerText: true, higherContrast: false }, { largerText: false, higherContrast: true }, { largerText: true, higherContrast: true }]) {
      const { root } = await home({ day: DAY, light: 'Light on' }, preferences);
      const theme = calmTheme(preferences);
      for (const text of all(root, 'Text').filter((t) => t.children.length > 0)) {
        expect(fontSize(text), String(text.children.join(''))).toBeGreaterThanOrEqual(theme.fontSize('body'));
        expect(contrastOf(text), String(text.children.join(''))).toBeGreaterThanOrEqual(7);
      }
      // The date is always somewhere.
      expect(texts(root).some((t) => t === 'Monday 19 October')).toBe(true);
    }
  });

  it('is as it was — the question — when the server says no day', async () => {
    const { root } = await home({ day: undefined });
    expect(headers(root).map((h) => h.children.join(''))).toEqual(['What would you like to watch?']);
  });
});

describe('where the focus starts', () => {
  it('is the first film, and only there', async () => {
    const { root } = await home(WITH_EVERYTHING);
    expect(preferred(root)).toEqual([named(tile(root, BUNNY))]);
  });

  it('is the film she last watched, when she comes back from it', async () => {
    const { root } = await home({ ...WITH_EVERYTHING, lastWatchedId: TEARS.id });
    expect(preferred(root)).toEqual([named(tile(root, TEARS))]);
  });

  it.each([
    'Sintel. 15 minutes',
    'Tears of Steel. 12 minutes',
    'A note from Sarah is waiting. Press OK to open it.',
    'Your light in the window. Light on. Press OK to see who can see it.',
    'Your mantelpiece. Press OK to see the pictures you have kept.',
    'Easier to see. Press OK for larger text or higher contrast.',
  ])('goes back to "%s" when she was there before a card came', async (label) => {
    const drawn = await home(WITH_EVERYTHING);
    at(5_000);
    await focus(button(drawn.root, label));
    at(10_000);
    await drawn.redraw({ drawn: false, cardVisible: true });
    at(20_000);
    await drawn.redraw({ drawn: true, cardVisible: false });

    expect(preferred(drawn.root)).toEqual([label]);
  });

  it('goes back to where she was when a card has come and gone — not to the first film', async () => {
    const drawn = await home(WITH_EVERYTHING);
    // She moves to her light, a while after the screen came up.
    at(5_000);
    await focus(button(drawn.root, 'Your light in the window. Light on. Press OK to see who can see it.'));

    // A card comes, and the platform passes the focus along on its way to it: not hers.
    at(30_000);
    await drawn.redraw({ cardVisible: true });
    await focus(tile(drawn.root, SINTEL));
    at(40_000);
    await drawn.redraw({ cardVisible: false });
    // And sets it down again on the way back: not hers either.
    at(40_030);
    await focus(tile(drawn.root, TEARS));
    await drawn.redraw({});

    expect(preferred(drawn.root)).toEqual([named(button(drawn.root, 'Your light in the window. Light on. Press OK to see who can see it.'))]);
  });
});

describe('a press', () => {
  it('starts the film she pressed — once the home has been on screen a second', async () => {
    const onChoose = vi.fn();
    const { root } = await home({ onChoose });

    at(1_000);
    await pressOk(tile(root, SINTEL));

    expect(onChoose).toHaveBeenCalledTimes(1);
    expect(onChoose).toHaveBeenCalledWith(SINTEL);
  });

  it('opens what is waiting, her light, her mantelpiece and Easier to see, each by its own button', async () => {
    const onOpenWaiting = vi.fn();
    const onOpenLight = vi.fn();
    const onOpenMantel = vi.fn();
    const onOpenSeeing = vi.fn();
    const { root } = await home({ ...WITH_EVERYTHING, onOpenWaiting, onOpenLight, onOpenMantel, onOpenSeeing });
    at(2_000);

    await pressOk(button(root, 'A note from Sarah is waiting. Press OK to open it.'));
    await pressOk(button(root, 'Your light in the window. Light on. Press OK to see who can see it.'));
    await pressOk(button(root, 'Your mantelpiece. Press OK to see the pictures you have kept.'));
    await pressOk(button(root, 'Easier to see. Press OK for larger text or higher contrast.'));

    for (const opened of [onOpenWaiting, onOpenLight, onOpenMantel, onOpenSeeing]) expect(opened).toHaveBeenCalledTimes(1);
  });

  it('does nothing in the home’s first second — at launch, and again after a card goes — and the next press works', async () => {
    const onChoose = vi.fn();
    const drawn = await home({ onChoose });

    at(400);
    await pressOk(tile(drawn.root, BUNNY));
    expect(onChoose).not.toHaveBeenCalled();

    // A note comes and is answered; the second OK, 317 ms later, lands on the film underneath.
    at(30_000);
    await drawn.redraw({ cardVisible: true });
    at(40_000);
    await drawn.redraw({ cardVisible: false });
    at(40_317);
    await pressOk(tile(drawn.root, BUNNY));
    // Nor with no key at all — the platform's own click — and pressing early does not make the second longer.
    await press(tile(drawn.root, BUNNY));
    expect(onChoose).not.toHaveBeenCalled();

    at(41_000);
    await pressOk(tile(drawn.root, BUNNY));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it('does nothing when OK went down somewhere else and came up here — and the app is still told the key came up', async () => {
    const onChoose = vi.fn();
    const onKeyUp = vi.fn();
    // OK went down in the film, before Back brought the home screen back.
    const drawn = await home({ onChoose, onKeyUp, okDownSince: () => T - 500 });

    at(5_000);
    await pressOk(tile(drawn.root, BUNNY));
    expect(onChoose).not.toHaveBeenCalled();
    expect(onKeyUp).toHaveBeenCalledTimes(1);

    // Once it is up, the next press is hers.
    await drawn.redraw({ okDownSince: () => null });
    await pressOk(tile(drawn.root, BUNNY));
    expect(onChoose).toHaveBeenCalledWith(BUNNY);
  });

  it('does nothing while Wick is behind another app, and waits its second when Wick comes back', async () => {
    const onChoose = vi.fn();
    const drawn = await home({ onChoose });
    at(60_000);
    await drawn.redraw({ inFront: false });
    at(600_000);
    await drawn.redraw({ inFront: true });

    at(600_317);
    await pressOk(tile(drawn.root, BUNNY));
    expect(onChoose).not.toHaveBeenCalled();
    at(601_000);
    await pressOk(tile(drawn.root, BUNNY));
    expect(onChoose).toHaveBeenCalledTimes(1);
  });

  it('holds every one of its buttons to that second, and to a press that began on it — and tells the app each time OK comes up', async () => {
    const opened = { onChoose: vi.fn(), onOpenWaiting: vi.fn(), onOpenLight: vi.fn(), onOpenMantel: vi.fn(), onOpenSeeing: vi.fn() };
    const onKeyUp = vi.fn();
    const drawn = await home({ ...WITH_EVERYTHING, ...opened, onKeyUp, okDownSince: () => T - 1 });

    at(400);
    for (const b of buttons(drawn.root)) await press(b);
    at(5_000);
    // OK went down before the home came up, and comes up on each in turn: none of them is pressed.
    for (const b of buttons(drawn.root)) await pressOk(b);
    for (const handler of Object.values(opened)) expect(handler).not.toHaveBeenCalled();
    expect(onKeyUp).toHaveBeenCalledTimes(7);
  });

  it('forgets a press that began on a screen since taken down: a film came and went, and OK coming up starts nothing', async () => {
    const onChoose = vi.fn();
    const first = await home({ onChoose });
    at(5_000);
    const down = tile(first.root, BUNNY).props.onPressIn as () => void;
    await settle(() => down());
    await first.unmount();

    // The home screen again, after the film, with the key still to come up.
    at(600_000);
    const again = await home({ onChoose });
    at(602_000);
    await settle(() => {
      (tile(again.root, BUNNY).props.onPressOut as () => void)();
      (tile(again.root, BUNNY).props.onPress as () => void)();
    });
    expect(onChoose).not.toHaveBeenCalled();
  });

  it('is never a hold: OK held for two seconds on anything here asks for the offer to ring her instead', async () => {
    const onHold = vi.fn();
    const { root } = await home({ ...WITH_EVERYTHING, onHold });

    for (const b of buttons(root)) {
      expect(b.props.delayLongPress).toBe(HOLD_MS);
      await settle(() => (b.props.onLongPress as () => void)());
    }
    expect(onHold).toHaveBeenCalledTimes(buttons(root).length);
  });
});

describe('holding OK (press/HoldLine.tsx)', () => {
  beforeEach(() => {
    // The line waits its 0.4 s on a timer: this time the timers are faked too.
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
    vi.setSystemTime(T);
  });

  it('shows from 0.4 s what holding will do, and nothing before', async () => {
    const drawn = await home();
    await settle(() => (tile(drawn.root, BUNNY).props.onPressIn as () => void)());
    await settle(() => void vi.advanceTimersByTime(300));
    expect(texts(drawn.root)).not.toContain('Keep holding to ask for a call');
    await settle(() => void vi.advanceTimersByTime(100));
    expect(texts(drawn.root)).toContain('Keep holding to ask for a call');
  });

  it('names whom it would ask, when the television knows', async () => {
    const drawn = await home({ holdName: 'Sarah' });
    await settle(() => (tile(drawn.root, BUNNY).props.onPressIn as () => void)());
    await settle(() => void vi.advanceTimersByTime(500));
    expect(texts(drawn.root)).toContain('Keep holding to ask Sarah to ring you');
  });

  it('goes the moment OK is let go — and nothing is asked', async () => {
    const onHold = vi.fn();
    const drawn = await home({ onHold });
    await settle(() => (tile(drawn.root, BUNNY).props.onPressIn as () => void)());
    await settle(() => void vi.advanceTimersByTime(1200));
    await settle(() => (tile(drawn.root, BUNNY).props.onPressOut as () => void)());
    expect(texts(drawn.root)).not.toContain('Keep holding to ask for a call');
    expect(onHold).not.toHaveBeenCalled();
  });

  it('goes when the hold is made, and the offer is asked for', async () => {
    const onHold = vi.fn();
    const drawn = await home({ onHold });
    await settle(() => (tile(drawn.root, BUNNY).props.onPressIn as () => void)());
    await settle(() => void vi.advanceTimersByTime(2000));
    await settle(() => (tile(drawn.root, BUNNY).props.onLongPress as () => void)());
    expect(onHold).toHaveBeenCalledTimes(1);
    expect(texts(drawn.root)).not.toContain('Keep holding to ask for a call');
  });
});

describe('while something else has the remote', () => {
  it('can be focused nowhere when a card, her mantelpiece or her pictures are over it', async () => {
    const { root } = await home({ ...WITH_EVERYTHING, cardVisible: true });

    expect(buttons(root).length).toBe(7);
    for (const b of buttons(root)) expect(b.props.focusable, String(b.props.accessibilityLabel)).toBe(false);
    expect(preferred(root)).toEqual([]);
  });

  it('draws nothing at all behind a card — no word, no picture, nothing to press — only the ground the card stands on', async () => {
    const drawn = await home({ ...WITH_EVERYTHING, drawn: false, cardVisible: true });

    expect(all(drawn.root, 'Text').length).toBe(0);
    expect(all(drawn.root, 'Image').length).toBe(0);
    expect(buttons(drawn.root).length).toBe(0);
    const views = all(drawn.root, 'View');
    expect(views.length).toBe(1);
    expect(flat(views[0]!.props.style).backgroundColor).toBe(calmTheme(STANDARD).palette.ground);
  });

  it('remembers where she was while its rows are out, and gives the focus back there when they return', async () => {
    const drawn = await home(WITH_EVERYTHING);
    at(5_000);
    await focus(button(drawn.root, 'Your mantelpiece. Press OK to see the pictures you have kept.'));
    at(10_000);
    await drawn.redraw({ drawn: false, cardVisible: true });
    at(70_000);
    await drawn.redraw({ drawn: true, cardVisible: false });

    expect(preferred(drawn.root)).toEqual([named(button(drawn.root, 'Your mantelpiece. Press OK to see the pictures you have kept.'))]);
    // And its one second is counted from then.
    const onOpenMantel = vi.fn();
    await drawn.redraw({ onOpenMantel });
    await pressOk(button(drawn.root, 'Your mantelpiece. Press OK to see the pictures you have kept.'));
    expect(onOpenMantel).not.toHaveBeenCalled();
    await settle(() => at(71_000));
    await pressOk(button(drawn.root, 'Your mantelpiece. Press OK to see the pictures you have kept.'));
    expect(onOpenMantel).toHaveBeenCalledTimes(1);
  });
});

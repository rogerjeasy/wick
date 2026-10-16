/**
 * Easier to see: her television adapts to what she can see.
 *
 * One pill on her home screen, "Easier to see", opens a card with exactly
 * three buttons — "Larger text", "Higher contrast", "Back". Each of the
 * first two turns its setting on or off and says how it stands ("Larger
 * text: on"). The settings are vega-calm-ui's (packages/vega-calm-ui
 * theme.ts): larger text sets every word 1.25 times the size, so the 32pt
 * floor becomes 40pt; higher contrast is pure black and white, at least
 * 15:1, with a thicker focus ring. They apply to everything at once,
 * through the one provider at the root of the app (SeeingProvider.tsx),
 * never screen by screen.
 *
 * What the platform says comes first, until she says otherwise. Vega's
 * `AccessibilityInfo` answers whether its high-contrast text setting is on
 * (`isHighTextContrastEnabled`, followed live by `highTextContrastChanged`),
 * and that is higher contrast's default. Vega has no text-size setting an
 * app can ask about (FRICTION.md FL-038), so larger text is off until she
 * turns it on. Her press is her choice and outlasts the platform's: once
 * she has pressed one, it stays as she left it whatever the platform says.
 *
 * Her choice is kept on the television, in the same file store as
 * everything else this app keeps (seeingStore.ts). It belongs to the
 * television and the person in front of it, not the home: it is not sent
 * anywhere, and nothing about it reaches the family. The Vega Virtual
 * Device keeps no file across launches (FRICTION.md FL-013), so there it
 * is forgotten at every launch.
 *
 * Pure, and imports nothing of the platform.
 */
import type { CalmAction, CalmPreferences } from '@wick/vega-calm-ui';
import type { Say } from '../words/words.js';

/** What she has pressed. A setting she has never pressed is absent: then the platform's is used. */
export interface SeeingChoice {
  readonly largerText?: boolean;
  readonly higherContrast?: boolean;
}

/** What the platform says. */
export interface SystemSeeing {
  /** Vega's high-contrast text setting. */
  readonly higherContrast: boolean;
}

export const NO_CHOICE: SeeingChoice = {};

/** The ids of the card's three buttons. */
export const SEEING_ACTIONS = {
  largerText: 'larger_text',
  higherContrast: 'higher_contrast',
  back: 'back',
} as const;

/** What the television is drawn with: her choice where she has made one, the platform's where she has not. */
export function seeingPreferences(choice: SeeingChoice, system: SystemSeeing): CalmPreferences {
  return {
    largerText: choice.largerText ?? false,
    higherContrast: choice.higherContrast ?? system.higherContrast,
  };
}

/** The card's three buttons, each saying how its setting stands. Back last; the first holds the focus. */
export function seeingActions(preferences: CalmPreferences, say: Say): readonly CalmAction[] {
  return [
    { id: SEEING_ACTIONS.largerText, label: say(preferences.largerText ? 'seeing.largerOn' : 'seeing.largerOff'), kind: 'primary' },
    { id: SEEING_ACTIONS.higherContrast, label: say(preferences.higherContrast ? 'seeing.contrastOn' : 'seeing.contrastOff'), kind: 'secondary' },
    { id: SEEING_ACTIONS.back, label: say('seeing.back'), kind: 'dismiss' },
  ];
}

export interface SeeingPress {
  /** Her choice after the press. The same object when nothing changed. */
  readonly choice: SeeingChoice;
  /** The card is put away: Back. */
  readonly close: boolean;
}

/**
 * A press on the card. Each of the first two turns its setting the other
 * way from how it stands now — the platform's default included — and that
 * is her choice from then on. Back closes the card and changes nothing.
 * Anything else does nothing at all.
 */
export function pressSeeing(choice: SeeingChoice, now: CalmPreferences, actionId: string): SeeingPress {
  switch (actionId) {
    case SEEING_ACTIONS.largerText:
      return { choice: { ...choice, largerText: !now.largerText }, close: false };
    case SEEING_ACTIONS.higherContrast:
      return { choice: { ...choice, higherContrast: !now.higherContrast }, close: false };
    case SEEING_ACTIONS.back:
      return { choice, close: true };
    default:
      return { choice, close: false };
  }
}

/** Her choice as it is written to the file: only what she has pressed. */
export function writeSeeing(choice: SeeingChoice): string {
  return JSON.stringify({
    ...(choice.largerText !== undefined ? { largerText: choice.largerText } : {}),
    ...(choice.higherContrast !== undefined ? { higherContrast: choice.higherContrast } : {}),
  });
}

/** Her choice as a launch before this one wrote it — and nothing for anything that is not. */
export function readSeeing(raw: string): SeeingChoice {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return NO_CHOICE;
    const { largerText, higherContrast } = parsed as Record<string, unknown>;
    return {
      ...(typeof largerText === 'boolean' ? { largerText } : {}),
      ...(typeof higherContrast === 'boolean' ? { higherContrast } : {}),
    };
  } catch {
    return NO_CHOICE;
  }
}

/** The Easier to see card's name, for the one-second settle and the screen reader (press/settle.ts, read/announce.ts). */
export const SEEING_CARD = 'seeing';

/**
 * Whether the Easier to see card is on screen: she opened it, and nothing
 * has come over it. A card from the server comes first — the door above
 * all — and the Easier to see card is there again when it has gone; the
 * door camera, opened from the door's card, keeps it hidden too.
 */
export function seeingCardShows(at: { readonly open: boolean; readonly card: boolean; readonly liveOpen: boolean }): boolean {
  return at.open && !at.card && !at.liveOpen;
}

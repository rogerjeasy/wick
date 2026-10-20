/**
 * Her television's icons (docs/design/DESIGN.md §5): what each means, and
 * which picture shows it in a theme — pure, so it is tested without a
 * device (icons/__tests__/icons.test.ts).
 *
 * The pictures are Lucide's, rendered to PNG at build time by
 * `npm run tv:icons` (scripts/tv-icons.mjs) and shown with the platform's
 * own `Image`: no native module, so Fire OS needs nothing new for them.
 * An icon is never the only thing that says what it means: it stands
 * beside a word, or carries the screen reader's label (Icon.tsx).
 */
import type { CalmTheme } from '@wick/vega-calm-ui';

/** Every icon the television draws, by what it means (scripts/tv-icons.mjs ICONS has Lucide's names). */
export const ICON_NAMES = ['door', 'note', 'read', 'light', 'mantel', 'seeing', 'tour', 'play', 'pause', 'hold'] as const;
export type IconName = (typeof ICON_NAMES)[number];

/** `ink` on the warm dark; `ground` on an amber first button. */
export type IconTone = 'ink' | 'ground';

/** The sizes the pictures are made for, in dp: body text at the floor, and with larger text on. */
export const ICON_SIZES_DP = [32, 40] as const;

/** An icon is as tall as the line of body text beside it: 32dp at the floor, 40dp with larger text on. */
export function iconSizeDp(theme: CalmTheme): 32 | 40 {
  return theme.preferences.largerText ? 40 : 32;
}

/**
 * The picture to draw. With higher contrast on the first button is black,
 * not amber, so an icon on it is drawn in ink like every other.
 */
export function iconKey(name: IconName, tone: IconTone, theme: CalmTheme): string {
  const shown: IconTone = theme.preferences.higherContrast ? 'ink' : tone;
  return `${name}-${shown}-${iconSizeDp(theme)}`;
}

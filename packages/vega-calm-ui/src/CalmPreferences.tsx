/**
 * The viewer's preferences, given to every component at once.
 *
 * Put one `CalmPreferencesProvider` at the root of the app with what the
 * viewer asked for — larger text, higher contrast — and every component
 * of this package, and every one of yours that asks `useCalmTheme()` or
 * `useCalmStyles()`, is drawn in it. Nothing is changed screen by screen.
 * Without a provider every component is drawn at the floor, as it always
 * was.
 *
 * A card that falls back to the standard size to keep its words whole
 * (theme.ts fitCard) draws its children inside `CalmThemeProvider` with
 * that theme, so a notice or a picture's caption under it falls back with
 * it. `CalmText` is the way to write words that follow.
 */
import * as React from 'react';
import { StyleSheet, Text } from '@amazon-devices/react-native-kepler';
import type { TypeRole } from './constraints.js';
import { calmTheme, stylesFor, STANDARD_PREFERENCES, type CalmPreferences, type CalmTheme } from './theme.js';

const ThemeContext = React.createContext<CalmTheme>(calmTheme(STANDARD_PREFERENCES));

export interface CalmPreferencesProviderProps {
  readonly preferences: CalmPreferences;
  readonly children?: React.ReactNode;
}

/** Every component under it is drawn with these preferences. */
export function CalmPreferencesProvider({ preferences, children }: CalmPreferencesProviderProps): React.JSX.Element {
  const theme = calmTheme(preferences);
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** Everything under it is drawn in exactly this theme. */
export function CalmThemeProvider({ theme, children }: { readonly theme: CalmTheme; readonly children?: React.ReactNode }): React.JSX.Element {
  return <ThemeContext.Provider value={theme}>{children}</ThemeContext.Provider>;
}

/** The theme this component is drawn in: its sizes, colours and focus ring. */
export function useCalmTheme(): CalmTheme {
  return React.useContext(ThemeContext);
}

/** What the viewer asked for, as the theme this component is drawn in says it. */
export function useCalmPreferences(): CalmPreferences {
  return useCalmTheme().preferences;
}

/**
 * A component's styles, made from the theme it is drawn in. Write the
 * styles as a function of the theme, outside the component, so the same
 * function is handed in each time and each theme's styles are made once:
 *
 *   const makeStyles = (t: CalmTheme) => StyleSheet.create({ line: { color: t.palette.ink, fontSize: t.fontSize('body') } });
 *   // in the component
 *   const styles = useCalmStyles(makeStyles);
 */
export function useCalmStyles<T>(make: (theme: CalmTheme) => T): T {
  return stylesFor(make, useCalmTheme());
}

export interface CalmTextProps {
  readonly children?: React.ReactNode;
  /** The size: body unless asked. */
  readonly role?: TypeRole;
  /** `ink` for what is read first, `dim` for what is said beside it. */
  readonly tone?: 'ink' | 'dim';
  readonly numberOfLines?: number;
  readonly accessibilityLiveRegion?: 'none' | 'polite' | 'assertive';
  readonly accessibilityRole?: 'header' | 'text';
}

const makeTextStyles = (t: CalmTheme) =>
  StyleSheet.create({
    ink: { color: t.palette.ink },
    dim: { color: t.palette.inkDim },
    body: { fontSize: t.fontSize('body'), lineHeight: t.lineHeight('body') },
    headline: { fontSize: t.fontSize('headline'), lineHeight: t.lineHeight('headline') },
    display: { fontSize: t.fontSize('display'), lineHeight: t.lineHeight('display') },
  });

/** Words in the theme they are drawn in: never under the floor, always at the theme's contrast. */
export function CalmText({ children, role = 'body', tone = 'ink', numberOfLines, accessibilityLiveRegion, accessibilityRole }: CalmTextProps): React.JSX.Element {
  const styles = useCalmStyles(makeTextStyles);
  return (
    <Text
      style={[styles[role], tone === 'ink' ? styles.ink : styles.dim]}
      {...(numberOfLines !== undefined ? { numberOfLines } : {})}
      {...(accessibilityLiveRegion !== undefined ? { accessibilityLiveRegion } : {})}
      {...(accessibilityRole !== undefined ? { accessibilityRole } : {})}
    >
      {children}
    </Text>
  );
}

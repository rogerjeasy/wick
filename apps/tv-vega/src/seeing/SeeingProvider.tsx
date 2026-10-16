/**
 * Easier to see, for the whole app (seeing.ts): at the root, around every
 * screen — the pairing screen, her television and a family member's — so
 * what she chose reaches every word through vega-calm-ui's one provider.
 *
 * Nothing is drawn until her choice has been read back from the disk, so
 * a launch does not begin at one size and jump to another; a disk that
 * neither answers nor refuses keeps the screen dark for a second at most,
 * as her language does (ResidentApp.tsx).
 *
 * The platform's high-contrast setting is followed live, and is the
 * default until she presses (seeing.ts seeingPreferences). What the
 * platform says about text size is logged once at launch — not followed:
 * React Native already applies the platform's font scale to every Text
 * itself, so following it again would scale twice (FRICTION.md FL-038).
 */
import * as React from 'react';
import { Dimensions, View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import { CalmPreferencesProvider, calmTheme, useCalmPreferences, useHighTextContrastEnabled, type CalmPreferences } from '@wick/vega-calm-ui';
import { NO_CHOICE, pressSeeing, seeingPreferences, type SeeingChoice } from './seeing.js';
import { keepSeeing, recallSeeing } from './seeingStore.js';

/** How long the screen may stay undrawn while her choice is read back. */
const SEEING_RECALL_WAIT_MS = 1000;

export interface Seeing {
  /** What the television is drawn with now. */
  readonly preferences: CalmPreferences;
  /** A press on the Easier to see card: true when it is Back, and the card is put away. */
  readonly press: (actionId: string) => boolean;
}

const SeeingContext = React.createContext<Seeing>({ preferences: { largerText: false, higherContrast: false }, press: () => true });

/** Her Easier to see settings, and the one way to change them: a press on its card. */
export function useSeeing(): Seeing {
  return React.useContext(SeeingContext);
}

export function SeeingProvider({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const [choice, setChoice] = React.useState<SeeingChoice | null>(null);
  const systemContrast = useHighTextContrastEnabled();

  React.useEffect(() => {
    let live = true;
    void recallSeeing(KeplerFileSystem).then((recalled) => {
      if (live) setChoice((known) => known ?? recalled);
    });
    const giveUp = setTimeout(() => setChoice((known) => known ?? NO_CHOICE), SEEING_RECALL_WAIT_MS);
    // What the platform says about text, once: Vega offers no text-size setting to ask about (FRICTION.md FL-038).
    try {
      const fontScale = Dimensions.get('window').fontScale;
      console.info('seeing_platform', JSON.stringify({ fontScale }));
    } catch {
      // Nothing to say.
    }
    return () => {
      live = false;
      clearTimeout(giveUp);
    };
  }, []);

  const preferences = React.useMemo(() => seeingPreferences(choice ?? NO_CHOICE, { higherContrast: systemContrast }), [choice, systemContrast]);
  const latest = React.useRef({ choice: choice ?? NO_CHOICE, preferences, systemContrast });
  latest.current = { choice: choice ?? NO_CHOICE, preferences, systemContrast };

  const press = React.useCallback((actionId: string): boolean => {
    const next = pressSeeing(latest.current.choice, latest.current.preferences, actionId);
    if (next.choice !== latest.current.choice) {
      // A second press before the screen is drawn again turns it from where the first left it.
      latest.current = { ...latest.current, choice: next.choice, preferences: seeingPreferences(next.choice, { higherContrast: latest.current.systemContrast }) };
      setChoice(next.choice);
      void keepSeeing(KeplerFileSystem, next.choice);
    }
    return next.close;
  }, []);

  const seeing = React.useMemo<Seeing>(() => ({ preferences, press }), [preferences, press]);

  // Not yet known how she likes it: the ground of the screen, and nothing on it.
  if (choice === null) return <View style={{ flex: 1, backgroundColor: calmTheme().palette.ground }} />;

  return (
    <SeeingContext.Provider value={seeing}>
      <CalmPreferencesProvider preferences={preferences}>{children}</CalmPreferencesProvider>
    </SeeingContext.Provider>
  );
}

/**
 * A family member's own television (family/FamilyApp.tsx) is not hers:
 * Easier to see is not offered there, and its pages are laid out at the
 * standard size (family/layout.ts measures them so). It still follows the
 * platform's high-contrast setting, through the same theme.
 */
export function AtStandardSize({ children }: { readonly children?: React.ReactNode }): React.JSX.Element {
  const { higherContrast } = useCalmPreferences();
  return <CalmPreferencesProvider preferences={{ largerText: false, higherContrast }}>{children}</CalmPreferencesProvider>;
}

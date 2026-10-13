import * as React from 'react';
import { AppState } from 'react-native';

/**
 * Whether Wick is the app on screen. Vega tells an app it is leaving the
 * screen and stops its JavaScript a few seconds later (FL-022), so the
 * `background` event is the last chance to hand over to the card service
 * (ResidentApp.tsx) — and, on a family member's own television, the moment
 * to stop asking the Wick server (family/FamilyApp.tsx).
 */
export function useOnScreen(): boolean {
  const [onScreen, setOnScreen] = React.useState(AppState.currentState !== 'background');
  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setOnScreen(state !== 'background'));
    return () => subscription.remove();
  }, []);
  return onScreen;
}

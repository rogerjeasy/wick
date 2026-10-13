/**
 * Wick on a family member's own television — "Sarah's television"
 * (packages/contracts/src/familyTelevision.ts). The family app with a
 * remote: it shows one member what the resident lets them see, and lets
 * them answer the two things she can ask of them.
 *
 * Mounted by App.tsx instead of ResidentApp.tsx, never beside it. Nothing
 * of the resident's is here: no card channel, no card service, no
 * DeviceEvent, no Natural-Break Engine, no programme, nothing written to
 * Content Personalization. This component and everything it imports talks
 * to one place — the Wick server, over HTTPS, with the device token
 * (familyClient.ts) — and family/__tests__/apart.test.ts fails if that
 * stops being true.
 *
 * Thin by design. When to ask again is looker.ts; what the answers mean is
 * familyClient.ts; which card is in front and what a press does is
 * familyScreen.ts. Each is tested without React.
 */
import * as React from 'react';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import type { DeviceToken } from '@wick/contracts';
import { safe } from '@wick/vega-calm-ui';
import type { PairingFlow } from '../pairing/PairingFlow.js';
import { useOnScreen } from '../useOnScreen.js';
import { FamilyHome } from './FamilyHome.js';
import { createFamilyClient, type Renewed } from './familyClient.js';
import { pictureToShow, pressed, putAway, sentenceAfterPress, showing, stillPutAway, type PutAway, type ShownPicture } from './familyScreen.js';
import { FamilyLooker, type LookState } from './looker.js';
import { televisionMode } from './mode.js';

export interface FamilyAppProps {
  /** The token of a television a family member connected as their own. */
  readonly token: DeviceToken;
  /** The Wick server's origin (config.ts `wickServerUrl`). */
  readonly serverUrl: string;
  /** Asked for a fresh token when the server no longer takes this one. */
  readonly pairing: PairingFlow;
  /** This television is no longer connected: App.tsx forgets the token and shows the pairing screen. */
  readonly onSignedOut: () => void;
}

export function FamilyApp({ token, serverUrl, pairing, onSignedOut }: FamilyAppProps): React.JSX.Element {
  const onScreen = useOnScreen();
  const [look, setLook] = React.useState<LookState>({ kind: 'starting', unreachable: false });
  /** Cards that only say how something stands, put away on this screen with "All right". */
  const [put, setPut] = React.useState<PutAway>({});
  /** The sentence the server answered the last press with, shown in the card's place until "All right". */
  const [said, setSaid] = React.useState<string | undefined>(undefined);
  /** One press at a time: OK pressed twice is one answer. */
  const pressing = React.useRef(false);
  const shownPicture = React.useRef<ShownPicture | undefined>(undefined);

  const client = React.useMemo(
    () =>
      createFamilyClient({
        serverUrl,
        jwt: token.jwt,
        // The token just refused goes with the request: it is the proof a family television's fresh one is minted on.
        renew: async (heldJwt): Promise<Renewed> => {
          const renewed = await pairing.renew(token.deviceId, heldJwt);
          if (renewed === 'not_connected' || renewed === 'try_later') return renewed;
          // A fresh token that is not a family television's is not this screen's to use.
          return televisionMode(renewed.token) === 'family' ? { jwt: renewed.token.jwt } : 'not_connected';
        },
      }),
    [serverUrl, token, pairing],
  );

  const looker = React.useMemo(
    () =>
      new FamilyLooker({
        look: () => client.home(),
        onChange: (state) => {
          setLook(state);
          if (state.kind === 'home') setPut((current) => stillPutAway(current, state.home));
          // A sentence about a home that is no longer shown does not come back with it.
          else setSaid(undefined);
        },
      }),
    [client],
  );

  // Looks while this screen is up, and stops with it.
  const onScreenNow = React.useRef(onScreen);
  onScreenNow.current = onScreen;
  React.useEffect(() => {
    looker.setOnScreen(onScreenNow.current);
    looker.start();
    return () => looker.stop();
  }, [looker]);

  // Not while Wick is off screen; at once on the way back.
  React.useEffect(() => {
    looker.setOnScreen(onScreen);
  }, [looker, onScreen]);

  const signedOut = look.kind === 'signedOut';
  React.useEffect(() => {
    if (signedOut) onSignedOut();
  }, [signedOut, onSignedOut]);

  const home = look.kind === 'home' ? look.home : undefined;
  const shown = showing(home, put, said);

  // The picture's address is kept for as long as the same card shows one, in memory only.
  const picture = pictureToShow(shownPicture.current, shown.kind === 'card' ? shown.card : undefined);
  shownPicture.current = picture;

  const handleAction = React.useCallback(
    (actionId: string) => {
      const press = pressed(shown, actionId);
      if (press.do === 'clearSaid') return setSaid(undefined);
      if (press.do === 'putAway') return setPut((current) => putAway(current, press.card));
      if (press.do !== 'send' || !home || pressing.current) return;

      pressing.current = true;
      void (async () => {
        const answer = await client.press(press.press);
        pressing.current = false;
        if (answer.kind === 'notAllowed' || answer.kind === 'signedOut') looker.heard(answer);
        else setSaid(sentenceAfterPress(answer, home.residentName));
        // How the home stands now that the press has been answered.
        void looker.lookNow();
      })();
    },
    [shown, home, client, looker],
  );

  if (look.kind === 'signedOut') return <View style={styles.ground} />;
  return <FamilyHome look={look} shown={shown} pictureUrl={picture?.url} onAction={handleAction} />;
}

const styles = StyleSheet.create({
  ground: {
    flex: 1,
    backgroundColor: safe.ground,
  },
});

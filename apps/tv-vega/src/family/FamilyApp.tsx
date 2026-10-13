/**
 * Wick on a family member's own television — "Sarah's television"
 * (packages/contracts/src/familyTelevision.ts). The family app with a
 * remote: it shows one member what the resident lets them see, and lets
 * them answer the two things she can ask of them.
 *
 * Mounted by App.tsx instead of ResidentApp.tsx, never beside it. Nothing
 * of the resident's is here: no card channel, no DeviceEvent, no
 * Natural-Break Engine, no programme of her own, nothing written to Content
 * Personalization. This component and everything it imports talks to one
 * place — the Wick server, over HTTPS, with the device token
 * (familyClient.ts) — and family/__tests__/apart.test.ts fails if that
 * stops being true.
 *
 * Three screens, one at a time: the home (FamilyHome.tsx), something to
 * read (FamilyReader.tsx), and the seat beside her film (FamilySeat.tsx) —
 * which plays her film with the shared player and tells nobody where it is.
 *
 * On Vega it also starts the background service, which here holds no card
 * channel: it asks what waits for this member and says so in a toast while
 * another app is in front (offScreen.ts, headless/waitingService.ts).
 *
 * Thin by design. When to ask again is looker.ts; what the answers mean is
 * familyClient.ts; which card is in front and what a press does is
 * familyScreen.ts; the pages are reader.ts; her film is seat.ts. Each is
 * tested without React.
 */
import * as React from 'react';
import { Linking } from 'react-native';
import { StyleSheet, View, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import type { DeviceToken, FamilyTvPress } from '@wick/contracts';
import { safe } from '@wick/vega-calm-ui';
import { CARD_SERVICE_URI, launchCardService } from '../headless/launchCardService.js';
import type { PairingFlow } from '../pairing/PairingFlow.js';
import { useOnScreen } from '../useOnScreen.js';
import { FamilyHome } from './FamilyHome.js';
import { FamilyReader } from './FamilyReader.js';
import { FamilySeat } from './FamilySeat.js';
import { createFamilyClient, type Renewed } from './familyClient.js';
import { afterPress, afterSeatAnswer, pictureToShow, pressed, putAway, showing, somethingWaits, stillPutAway, waveOf, type PutAway, type ShownPicture } from './familyScreen.js';
import { FamilyLooker, type LookState } from './looker.js';
import { televisionMode } from './mode.js';
import { startOffScreenService } from './offScreen.js';
import { pressGuard, surfaceOf } from './presses.js';
import { turn, type ReaderKey, type Reading } from './reader.js';

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
  /** The pages open on screen, if any (reader.ts). */
  const [reading, setReading] = React.useState<Reading | undefined>(undefined);
  /** Whether this television is sat at her film (FamilySeat.tsx). */
  const [seated, setSeated] = React.useState(false);
  /** One press at a time: OK pressed twice is one answer. */
  const pressing = React.useRef(false);
  const shownPicture = React.useRef<ShownPicture | undefined>(undefined);
  /**
   * Which presses of OK count (presses.ts): a wave only after an arrow key,
   * a card's buttons not in the first second it is on screen. Whatever the
   * television does with the focus, nothing is sent by a press that was
   * not aimed at it.
   */
  const guard = React.useMemo(() => pressGuard(), []);
  /** How many times Wick has come back on screen: the home takes the focus off the wave again each time. */
  const [returns, setReturns] = React.useState(0);
  // Every key of the remote, as it arrives: the arrows are how a wave is aimed at.
  useTVEventHandler((event) => guard.key(event, Date.now()));

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
          if (state.kind === 'home') {
            setPut((current) => stillPutAway(current, state.home));
            return;
          }
          // A sentence about a home that is no longer shown does not come back with it — nor do its pages, nor the seat.
          setSaid(undefined);
          setReading(undefined);
          setSeated(false);
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

  // Not while Wick is off screen; at once on the way back. And all the
  // while it is on screen — in the seat too, where a question from her door
  // would otherwise be missed for the length of a film.
  React.useEffect(() => {
    looker.setOnScreen(onScreen);
  }, [looker, onScreen]);

  // Back on screen: whatever is there is new to whoever is looking, and the
  // focus is wherever the platform left it. No press counts for a second,
  // and none on the wave until an arrow has been pressed.
  const wasOnScreen = React.useRef(onScreen);
  React.useEffect(() => {
    if (onScreen && !wasOnScreen.current) {
      guard.returned(Date.now());
      setReturns((times) => times + 1);
    }
    wasOnScreen.current = onScreen;
  }, [onScreen, guard]);

  // What waits, said while Wick is off the screen (Vega): the way is opened
  // for the background service, and the service started — once connected,
  // and again each time Wick comes back on screen, as the resident's
  // television starts its own. Nothing at all on Fire OS.
  React.useEffect(() => {
    if (!onScreen) return;
    void startOffScreenService({
      serviceUri: CARD_SERVICE_URI,
      openWindow: () => pairing.openServiceWindow(token.deviceId, token.jwt),
      launch: () => launchCardService((uri) => Linking.openURL(uri)),
    });
  }, [onScreen, pairing, token]);

  const signedOut = look.kind === 'signedOut';
  React.useEffect(() => {
    if (signedOut) onSignedOut();
  }, [signedOut, onSignedOut]);

  const home = look.kind === 'home' ? look.home : undefined;
  const shown = showing(home, put, said);

  // The picture's address is kept for as long as the same card shows one, in memory only.
  const picture = pictureToShow(shownPicture.current, shown.kind === 'card' ? shown.card : undefined);
  shownPicture.current = picture;

  // What there is to press, said to the guard as it is drawn: it counts only when it changes.
  guard.surface(surfaceOf({ seated, reading, shown }), Date.now());

  /** Tells the server of a press, and does what its answer calls for (familyScreen.ts `afterPress`). */
  const send = React.useCallback(
    (press: FamilyTvPress) => {
      if (!home || pressing.current) return;
      pressing.current = true;
      void (async () => {
        const answer = await client.press(press);
        pressing.current = false;
        if (answer.kind === 'notAllowed' || answer.kind === 'signedOut') looker.heard(answer);
        const after = afterPress(press, answer, home.residentName);
        if (after.say) setSaid(after.say);
        if (after.seat) setSeated(true);
        // A quiet press that was done: its card goes from this screen now, not a look later.
        const hidden = after.hide ? home.cards.find((card) => card.id === press.cardId) : undefined;
        if (hidden) setPut((current) => putAway(current, hidden));
        // How the home stands now that the press has been answered.
        void looker.lookNow();
      })();
    },
    [home, client, looker],
  );

  const handleAction = React.useCallback(
    (actionId: string) => {
      // Pressed before the card could be read — a second OK meant for what was there before: nothing happens.
      if (!guard.cardActs(Date.now())) return;
      const press = pressed(shown, actionId);
      if (press.do === 'clearSaid') return setSaid(undefined);
      if (press.do === 'putAway') return setPut((current) => putAway(current, press.card));
      if (press.do === 'read') return setReading(press.reading);
      if (press.do === 'seat') return setSeated(true);
      if (press.do === 'send') send(press.press);
    },
    [shown, send, guard],
  );

  const wave = waveOf(home);
  const handleWave = React.useCallback(() => {
    // The focus was handed to the wave, not moved there by the member: nothing is sent.
    if (!guard.waveActs(Date.now())) return;
    if (wave?.kind === 'button') send(wave.press);
  }, [wave, send, guard]);
  const handleWaveFocus = React.useCallback(() => guard.waveFocused(Date.now()), [guard]);
  const handleWaveBlur = React.useCallback(() => guard.waveBlurred(), [guard]);

  const handleReaderKey = React.useCallback(
    (key: ReaderKey) => {
      if (!reading) return;
      // The reader has only just opened: a second OK from the card's "Read it" turns no page, and ends nothing. Back is always Back.
      if (key !== 'back' && !guard.cardActs(Date.now())) return;
      const turned = turn(reading, key);
      setReading(turned.reading);
      // Only ever that the last page was reached; nothing is shown in answer.
      if (turned.press) send(turned.press);
    },
    [reading, send, guard],
  );

  const handleLeaveSeat = React.useCallback(() => setSeated(false), []);
  /** An answer at the credits. The seat stays: its own next sentence says what each said, and hers when it comes. */
  const handleSeatAnswer = React.useCallback(
    async (press: FamilyTvPress): Promise<string | undefined> => {
      const answer = await client.press(press);
      if (answer.kind === 'notAllowed' || answer.kind === 'signedOut') {
        setSeated(false);
        looker.heard(answer);
        return undefined;
      }
      void looker.lookNow();
      return afterSeatAnswer(answer, home?.residentName);
    },
    [client, looker, home],
  );
  const handleSeatRefused = React.useCallback(
    (answer: { readonly kind: 'notAllowed'; readonly say: string } | { readonly kind: 'signedOut' }) => {
      setSeated(false);
      looker.heard(answer);
    },
    [looker],
  );
  const waitingWhileSeated = React.useCallback((seatCardId: string | undefined) => somethingWaits(home, put, seatCardId), [home, put]);

  if (look.kind === 'signedOut') return <View style={styles.ground} />;
  if (seated) {
    return <FamilySeat client={client} onScreen={onScreen} waiting={waitingWhileSeated} onLeave={handleLeaveSeat} onAnswer={handleSeatAnswer} onRefused={handleSeatRefused} />;
  }
  if (reading) return <FamilyReader reading={reading} onKey={handleReaderKey} />;
  return (
    <FamilyHome
      look={look}
      shown={shown}
      pictureUrl={picture?.url}
      onAction={handleAction}
      wave={wave}
      onWave={handleWave}
      onWaveFocus={handleWaveFocus}
      onWaveBlur={handleWaveBlur}
      returns={returns}
    />
  );
}

const styles = StyleSheet.create({
  ground: {
    flex: 1,
    backgroundColor: safe.ground,
  },
});

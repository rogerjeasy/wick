/**
 * Wick — main interactive component (com.wick.tv.main).
 *
 * This file does two things and nothing else: it gets the television its
 * token (pairing/PairingFlow.ts — the stored one, a refreshed one, or the
 * pairing screen), and it decides from that token whose television this is
 * (family/mode.ts):
 *
 *   - the resident's own — ResidentApp.tsx: her cards, her programmes, the
 *     Natural-Break Engine, the card channel and the card service;
 *   - a family member's own ("Sarah's television",
 *     packages/contracts/src/familyTelevision.ts) — family/FamilyApp.tsx:
 *     what the resident lets that one member see, asked of the Wick server.
 *
 * Exactly one of the two is mounted. Everything that is the resident's —
 * every effect that opens the card channel, starts the card service, sends
 * a DeviceEvent, runs the break engine or writes to Content Personalization
 * — lives inside ResidentApp and is imported by nothing else, so on a
 * family member's television none of it exists to run.
 * family/__tests__/apart.test.ts holds that to be so.
 *
 * Whose television it becomes is not chosen here: it is decided in the
 * family app, when the code on the pairing screen is entered.
 */
import * as React from 'react';
import type { DeviceToken } from '@wick/contracts';
import { View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import { useReportFullyDrawn } from '@amazon-devices/kepler-performance-api';
import { PairingFlow } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { connectTelevision, type Connecting } from './pairing/connect.js';
import { loadDeviceConfig } from './config.js';
import { SIMULATOR_DEVICE_ID, televisionIdentity } from './deviceId.js';
import { televisionMode } from './family/mode.js';
import { FamilyApp } from './family/FamilyApp.js';
import { ResidentApp } from './ResidentApp.js';
import { AtStandardSize, SeeingProvider } from './seeing/SeeingProvider.js';

/**
 * Easier to see (seeing/seeing.ts) is around everything — the pairing
 * screen, her television, a family member's — so a choice made on this
 * television reaches every word on it.
 */
export default function App(): React.JSX.Element {
  return (
    <SeeingProvider>
      <Television />
    </SeeingProvider>
  );
}

function Television(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  // Who this television is: its id, and the secret it proves a refresh with
  // where its storage keeps one (deviceId.ts). The app is the one process
  // that makes and changes it.
  const identity = React.useMemo(() => televisionIdentity(KeplerFileSystem, { writes: true }), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, KeplerFileSystem, fetch, identity),
    [config, identity],
  );

  const [screen, setScreen] = React.useState<Connecting | null>(null);
  /**
   * How many times a family member's television has been told it is no
   * longer connected (family/FamilyApp.tsx). Each time, the token is
   * forgotten and the television is set up again from a new code.
   */
  const [signedOut, setSignedOut] = React.useState(0);

  // The stored token, a refreshed one, or a code and the token that comes
  // when it is entered — tried again, calmly, for as long as the pairing
  // service cannot be reached (pairing/connect.ts). A try that fails never
  // leaves the screen empty, and never leaves it claiming for ever that a
  // code is on its way.
  React.useEffect(() => {
    const connecting = connectTelevision({
      deviceId: () => identity.deviceId(),
      pairing,
      // Signed out: the token is forgotten, and none is asked for again.
      signedOut: signedOut > 0,
      onChange: setScreen,
    });
    return () => connecting.cancel();
  }, [pairing, identity, signedOut]);

  const handleSignedOut = React.useCallback(() => {
    // The pairing screen at once, "Getting a code…", while the effect above fetches one.
    setScreen({ kind: 'pairing' });
    setSignedOut((times) => times + 1);
  }, []);

  // The resident's television, disconnected by the family, is told by
  // nobody: the edge only refuses it, and a token on disk that has not run
  // out is used without asking. So it asks (pairing/standing.ts) — by its
  // id, showing its token, and writing nothing down for the asking. "No
  // longer connected" is taken as a family television's sign-out is: the
  // token forgotten, the pairing screen, and no token asked for again.
  //
  // "Connected" comes with a fresh token, and the television takes it when
  // its own is near its end — an hour after launch where the disk keeps
  // none — so its channel is not cut off and refused until the next launch.
  // That is ResidentApp's to do, and does not come back through here: the
  // token this screen was made ready with stays the one it was launched
  // with. The disk is given the fresh one only over nothing, or over a
  // token that ends sooner (PairingFlow.keepIfLonger): a thirty-day token
  // is never replaced by an hour's.
  const ready = screen?.kind === 'ready' ? screen : undefined;
  const standing = React.useMemo(
    () =>
      ready
        ? {
            ask: (held: DeviceToken) => pairing.renew(held.deviceId, held.jwt, { remember: false }),
            onGone: handleSignedOut,
            keep: (fresh: DeviceToken) => pairing.keepIfLonger(fresh),
            // Fresh from the pairing service: it has just said this television is connected, and the token's hour starts now.
            ...(ready.asked ? { since: Date.now() } : {}),
            // The Vega Virtual Device goes where its id now belongs: a demo home brought it in from the family app (standing.ts).
            ...(ready.token.deviceId === SIMULATOR_DEVICE_ID ? { onMoved: (there: DeviceToken) => setScreen({ kind: 'ready', token: there, asked: true }) } : {}),
          }
        : undefined,
    [ready, pairing, handleSignedOut],
  );

  // Vega's fully-drawn marker (kepler-performance-api), once: the first screen she can act on — the pairing
  // code, or her television — is on. Without it the platform's KPI tool cannot measure launch to fully drawn.
  const reportFullyDrawn = useReportFullyDrawn();
  const drawn = React.useRef(false);
  const usable = screen?.kind === 'ready' || (screen?.kind === 'pairing' && screen.info !== undefined);
  React.useEffect(() => {
    if (!usable || drawn.current) return;
    drawn.current = true;
    reportFullyDrawn();
  }, [usable, reportFullyDrawn]);

  if (!screen) return <View style={{ flex: 1 }} />;
  // exactOptionalPropertyTypes forbids passing `info={undefined}` explicitly —
  // PairingScreenProps.info is optional (absent), not nullable.
  if (screen.kind === 'pairing') {
    return screen.info ? <PairingScreen info={screen.info} /> : <PairingScreen trying={screen.trying === true} />;
  }

  // The one branch. Nothing of the resident's is mounted on a family member's television.
  if (televisionMode(screen.token) === 'family') {
    return (
      <AtStandardSize>
        <FamilyApp token={screen.token} serverUrl={config.wickServerUrl} pairing={pairing} onSignedOut={handleSignedOut} />
      </AtStandardSize>
    );
  }
  // One home at a time: a television moved to another (the simulator, above) starts afresh there.
  return <ResidentApp key={screen.token.householdId} token={screen.token} config={config} {...(standing ? { standing } : {})} />;
}

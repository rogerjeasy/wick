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
import { View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import { PairingFlow } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { connectTelevision, type Connecting } from './pairing/connect.js';
import { loadDeviceConfig } from './config.js';
import { resolveDeviceId } from './deviceId.js';
import { televisionMode } from './family/mode.js';
import { FamilyApp } from './family/FamilyApp.js';
import { ResidentApp } from './ResidentApp.js';

export default function App(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, KeplerFileSystem),
    [config],
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
      deviceId: () => resolveDeviceId(KeplerFileSystem),
      pairing,
      // Signed out: the token is forgotten, and none is asked for again.
      signedOut: signedOut > 0,
      onChange: setScreen,
    });
    return () => connecting.cancel();
  }, [pairing, signedOut]);

  const handleSignedOut = React.useCallback(() => {
    // The pairing screen at once, "Getting a code…", while the effect above fetches one.
    setScreen({ kind: 'pairing' });
    setSignedOut((times) => times + 1);
  }, []);

  if (!screen) return <View style={{ flex: 1 }} />;
  // exactOptionalPropertyTypes forbids passing `info={undefined}` explicitly —
  // PairingScreenProps.info is optional (absent), not nullable.
  if (screen.kind === 'pairing') {
    return screen.info ? <PairingScreen info={screen.info} /> : <PairingScreen trying={screen.trying === true} />;
  }

  // The one branch. Nothing of the resident's is mounted on a family member's television.
  if (televisionMode(screen.token) === 'family') {
    return <FamilyApp token={screen.token} serverUrl={config.wickServerUrl} pairing={pairing} onSignedOut={handleSignedOut} />;
  }
  return <ResidentApp token={screen.token} config={config} />;
}

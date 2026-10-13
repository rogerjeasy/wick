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
import type { DeviceToken } from '@wick/contracts';
import { PairingFlow, type PairingStartResponse } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { loadDeviceConfig } from './config.js';
import { resolveDeviceId } from './deviceId.js';
import { televisionMode } from './family/mode.js';
import { FamilyApp } from './family/FamilyApp.js';
import { ResidentApp } from './ResidentApp.js';

type Screen =
  | { readonly kind: 'pairing'; readonly info?: PairingStartResponse }
  | { readonly kind: 'ready'; readonly token: DeviceToken };

export default function App(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, KeplerFileSystem),
    [config],
  );

  const [screen, setScreen] = React.useState<Screen | null>(null);
  /**
   * How many times a family member's television has been told it is no
   * longer connected (family/FamilyApp.tsx). Each time, the token is
   * forgotten and the television is set up again from a new code.
   */
  const [signedOut, setSignedOut] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const deviceId = await resolveDeviceId(KeplerFileSystem);
        // Signed out: the token is forgotten, and none is asked for again —
        // the server has just refused this television, and a refresh that
        // still answered would only bring it straight back here.
        if (signedOut > 0) await pairing.clearToken();
        const token = signedOut > 0 ? null : await pairing.loadToken(deviceId);
        if (cancelled) return;
        if (token) {
          setScreen({ kind: 'ready', token });
          return;
        }
        const info = await pairing.start(deviceId);
        if (cancelled) return;
        setScreen({ kind: 'pairing', info });
        try {
          const bound = await pairing.pollUntilBound(info.code);
          if (!cancelled) setScreen({ kind: 'ready', token: bound });
        } catch (e) {
          // pairing_timed_out / pairing_code_expired — the pairing screen
          // is already the correct fallback UI; nothing else to show.
          console.error('pairing_poll_failed', e);
        }
      } catch {
        // loadToken/start failing (e.g. no network reaching the pairing
        // API) must not leave `screen` stuck at null forever — that
        // renders as an empty View with zero feedback, indistinguishable
        // from a hang. Fall through to the pairing screen with no info;
        // PairingScreen's no-info case is already handled below.
        if (!cancelled) setScreen({ kind: 'pairing' });
      }
    })();
    return () => {
      cancelled = true;
    };
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
    return screen.info ? <PairingScreen info={screen.info} /> : <PairingScreen />;
  }

  // The one branch. Nothing of the resident's is mounted on a family member's television.
  if (televisionMode(screen.token) === 'family') {
    return <FamilyApp token={screen.token} serverUrl={config.wickServerUrl} pairing={pairing} onSignedOut={handleSignedOut} />;
  }
  return <ResidentApp token={screen.token} config={config} />;
}

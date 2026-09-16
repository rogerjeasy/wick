/**
 * Wick — main interactive component (com.wick.tv.main).
 *
 * The device renders and never decides. If you find yourself writing an `if`
 * about *whether* to show something, it belongs in the agent plane.
 * See docs/WICK-TECHNICAL.md §1.1.
 */
// TODO(S2): drive NaturalBreakEngine from PlayerService snapshots.
import * as React from 'react';
import { View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import type { QueuedCard } from '@wick/contracts';
import { CardRenderer } from './cards/CardRenderer.js';
import { PairingFlow, type PairingStartResponse } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { QueueStore } from './headless/QueueStore.js';
import { loadDeviceConfig } from './config.js';

const QUEUE_POLL_MS = 1000;
// TODO(S4): use the platform-assigned device id once verified — Appendix A.
const DEVICE_ID = 'wick-tv';

type Screen = { readonly kind: 'pairing'; readonly info?: PairingStartResponse } | { readonly kind: 'ready' };

export default function App(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, KeplerFileSystem),
    [config],
  );
  const store = React.useMemo(() => new QueueStore(KeplerFileSystem), []);

  const [screen, setScreen] = React.useState<Screen | null>(null);
  const [card, setCard] = React.useState<QueuedCard | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await pairing.loadToken();
      if (cancelled) return;
      if (token) {
        setScreen({ kind: 'ready' });
        return;
      }
      const info = await pairing.start(DEVICE_ID);
      if (cancelled) return;
      setScreen({ kind: 'pairing', info });
      try {
        await pairing.pollUntilBound(info.code);
        if (!cancelled) setScreen({ kind: 'ready' });
      } catch {
        // Left on the pairing screen; a real device would offer a retry
        // affordance here — out of scope for this pass.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  React.useEffect(() => {
    if (screen?.kind !== 'ready') return;
    let cancelled = false;
    const tick = async () => {
      const cards = await store.readAll();
      const door = cards.find((q) => q.urgency === 'DOOR' && q.card.type === 'DOOR');
      if (!cancelled) setCard(door ?? null);
    };
    void tick();
    const interval = setInterval(() => void tick(), QUEUE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [screen, store]);

  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      void store.remove(cardId);
      setCard(null);
      // The channel lives in the card service process (manifest.toml §3.1);
      // this is how the UI process gets an action back to it — see the
      // plan's Scope decisions.
      void store.enqueueOutbound({ t: 'card_action', cardId, action: actionId, at: Date.now() });
    },
    [store],
  );

  if (!screen) return <View style={{ flex: 1 }} />;
  // exactOptionalPropertyTypes forbids passing `info={undefined}` explicitly —
  // PairingScreenProps.info is optional (absent), not nullable.
  if (screen.kind === 'pairing') return screen.info ? <PairingScreen info={screen.info} /> : <PairingScreen />;

  return <View style={{ flex: 1 }}>{card ? <CardRenderer card={card.card} onAction={handleAction} /> : null}</View>;
}

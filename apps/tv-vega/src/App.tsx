/**
 * Wick — main interactive component (com.wick.tv.main).
 *
 * The device renders and never decides. If you find yourself writing an `if`
 * about *whether* to show something, it belongs in the agent plane. The one
 * exception, by design (§1.1, §3.4): *when* a DEFERRED card is allowed to
 * render is a real-time, on-device decision — that's what BreakController
 * (wrapping NaturalBreakEngine) is for, driven here instead of the raw
 * `urgency === 'DOOR'` filter this file used to run.
 *
 * Wick plays its own programmes (home/HomeScreen.tsx, watch/WatchScreen.tsx),
 * so BreakController gets real snapshots from a real player: a note from the
 * family sent mid-programme waits for the credits or a long pause, and the
 * door card comes straight through over the picture. Seen on the Vega
 * Virtual Device — SP-1 in FRICTION.md.
 */
import * as React from 'react';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { CardRenderer } from './cards/CardRenderer.js';
import { opensLiveView, removesCard } from './cards/cardActions.js';
import { LiveView } from './live/LiveView.js';
import { BreakController } from './break/BreakController.js';
import { PairingFlow, type PairingStartResponse } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { QueueStore } from './headless/QueueStore.js';
import type { PlayerSnapshot } from './player/PlayerService.js';
import { PlaybackEventStore, toStoredPlaybackEvent } from './personalization/PlaybackEventStore.js';
import { CATALOG, type Programme } from './catalog/catalog.js';
import { HomeScreen } from './home/HomeScreen.js';
import { WatchScreen } from './watch/WatchScreen.js';
import { toPlaybackDeviceEvent } from './watch/playbackRecorder.js';
import { createDeviceChannel } from './transport/createDeviceChannel.js';
import { holdCardChannel } from './transport/startCardChannel.js';
import { loadDeviceConfig } from './config.js';
import { DEVICE_ID } from './deviceId.js';

const QUEUE_POLL_MS = 1000;

/** The namespace Content Personalization files Wick's own programme ids under. */
const CONTENT_ID_NAMESPACE = 'wick';

type Screen =
  | { readonly kind: 'pairing'; readonly info?: PairingStartResponse }
  | { readonly kind: 'ready'; readonly token: DeviceToken };

export default function App(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl, householdId: config.householdId }, KeplerFileSystem),
    [config],
  );
  const store = React.useMemo(() => new QueueStore(KeplerFileSystem), []);
  const breakController = React.useMemo(() => new BreakController(), []);

  const [screen, setScreen] = React.useState<Screen | null>(null);
  const [card, setCard] = React.useState<QueuedCard | null>(null);
  const playbackStore = React.useMemo(() => new PlaybackEventStore(KeplerFileSystem), []);
  const [watching, setWatching] = React.useState<Programme | null>(null);
  const [lastWatchedId, setLastWatchedId] = React.useState<string | undefined>(undefined);
  /** M2: the door card whose live view is open over it. */
  const [liveFor, setLiveFor] = React.useState<string | null>(null);
  // Bumped on the way back from live view: remounting the card re-applies its
  // preferred focus, so OK works again at once rather than after an arrow key.
  const [returnedFromLive, setReturnedFromLive] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const token = await pairing.loadToken(DEVICE_ID);
        if (cancelled) return;
        if (token) {
          setScreen({ kind: 'ready', token });
          return;
        }
        const info = await pairing.start(DEVICE_ID);
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
  }, [pairing]);

  // FL-014: the card channel lives here, in the process that renders. The
  // card_service process that was meant to hold it never launches on the
  // VVD, so a card could be queued server-side and never reach the screen.
  // Holding it here means the one QueueStore instance the render loop reads
  // below is the one the channel writes into — no disk hand-off (FL-013).
  const token = screen?.kind === 'ready' ? screen.token : undefined;
  React.useEffect(() => {
    if (!token) return;
    const held = holdCardChannel(store, token, createDeviceChannel, config);
    return () => held.stop();
  }, [token, store, config]);

  React.useEffect(() => {
    if (screen?.kind !== 'ready') return;
    let cancelled = false;

    // The app is only ever JS-alive while foregrounded (§1.1's device
    // plane), so reaching 'ready' IS the foreground signal — no AppState
    // listener needed for that half. §4.3: this is the entire Rhythm
    // pillar's device-side input, batched (here: sent once on change,
    // which is already the minimum-chatter case a 10s coalescing window
    // would otherwise collapse multiple changes into).
    const foregroundAt = Date.now();
    breakController.setForeground(true, foregroundAt);
    void store.enqueueOutbound({ t: 'app_lifecycle', state: 'fg', at: foregroundAt });
    let lastSentBreakState: string | undefined;

    const tick = async () => {
      const now = Date.now();
      const cards = await store.readAll();
      const picked = breakController.pickCard(cards, now);
      if (!cancelled) setCard(picked ?? null);

      const state = breakController.breakState(now);
      if (state !== lastSentBreakState) {
        lastSentBreakState = state;
        void store.enqueueOutbound({ t: 'break_state', state, at: now });
      }
    };
    void tick();
    const interval = setInterval(() => void tick(), QUEUE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [screen, store, breakController]);

  const handleSnapshot = React.useCallback(
    (snapshot: PlayerSnapshot | undefined) => breakController.setPlayback(snapshot, Date.now()),
    [breakController],
  );

  // §4.3 and §3.3: the cloud hears about it now, over the channel this
  // process holds; the platform reads it later, from the local store.
  const handlePlaybackEvent = React.useCallback(
    (snapshot: PlayerSnapshot) => {
      const at = Date.now();
      void store.enqueueOutbound(toPlaybackDeviceEvent(snapshot, at));
      const stored = toStoredPlaybackEvent(snapshot, CONTENT_ID_NAMESPACE, at, true);
      // Best-effort: the VVD has no data root (FL-013), and a store that
      // cannot be written must not stop the programme.
      if (stored) playbackStore.append(stored).catch((e) => console.error('playback_event_store_failed', e));
    },
    [store, playbackStore],
  );

  const handleExitWatching = React.useCallback(() => {
    setWatching((current) => {
      if (current) setLastWatchedId(current.id);
      return null;
    });
  }, []);

  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      if (card && card.id === cardId && opensLiveView(card.card, actionId)) setLiveFor(cardId);
      if (card && card.id === cardId && removesCard(card.card, actionId)) {
        void store.remove(cardId);
        setCard(null);
      }
      // The outbox is drained by whichever process holds the channel — this
      // one, since FL-014 (holdCardChannel above).
      void store.enqueueOutbound({ t: 'card_action', cardId, action: actionId, at: Date.now() });
    },
    [store, card],
  );

  if (!screen) return <View style={{ flex: 1 }} />;
  // exactOptionalPropertyTypes forbids passing `info={undefined}` explicitly —
  // PairingScreenProps.info is optional (absent), not nullable.
  if (screen.kind === 'pairing') {
    return screen.info ? <PairingScreen info={screen.info} /> : <PairingScreen />;
  }

  return (
    <View style={styles.screen}>
      {watching ? (
        <WatchScreen
          programme={watching}
          onSnapshot={handleSnapshot}
          onPlaybackEvent={handlePlaybackEvent}
          cardVisible={card !== null}
          suspended={liveFor !== null}
          onExit={handleExitWatching}
        />
      ) : (
        <HomeScreen programmes={CATALOG} onChoose={setWatching} cardVisible={card !== null} lastWatchedId={lastWatchedId} />
      )}
      {/* Over the programme, at the bottom, never instead of it. */}
      {card ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CardRenderer key={`${card.id}:${returnedFromLive}`} card={card.card} onAction={handleAction} />
        </View>
      ) : null}
      {/* Over the card, not instead of it: Back returns to the card as it was. */}
      {liveFor ? (
        <LiveView
          pairingApiUrl={config.pairingApiUrl}
          jwt={screen.token.jwt}
          cardId={liveFor}
          onClose={() => {
            setLiveFor(null);
            setReturnedFromLive((n) => n + 1);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  // The door card anchors itself to the same corner (DoorCard.tsx); every
  // other card is laid out by this.
  cardLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    paddingHorizontal: 48,
    paddingBottom: 32,
  },
});

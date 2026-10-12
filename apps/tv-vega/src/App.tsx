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
 *
 * Watch together (packages/contracts/src/watch.ts): "Start the film" on the
 * card that says someone is ready opens that film, and from then on this
 * television says where the film is, for that one person
 * (watch/togetherReporter.ts). Nothing else she plays is ever sent that way.
 */
import * as React from 'react';
import { AppState, Linking } from 'react-native';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { CardRenderer } from './cards/CardRenderer.js';
import { opensLiveView, removesCard, startsFilm } from './cards/cardActions.js';
import { LiveView } from './live/LiveView.js';
import { BreakController } from './break/BreakController.js';
import { PairingFlow, type PairingStartResponse } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { QueueStore } from './headless/QueueStore.js';
import type { PlayerSnapshot } from './player/PlayerService.js';
import { PlaybackEventStore, toStoredPlaybackEvent } from './personalization/PlaybackEventStore.js';
import { CATALOG, programmeById, type Programme } from './catalog/catalog.js';
import { HomeScreen } from './home/HomeScreen.js';
import { waitingLine } from './home/waiting.js';
import { WatchScreen } from './watch/WatchScreen.js';
import { toPlaybackDeviceEvent } from './watch/playbackRecorder.js';
import { TogetherReporter, type Together } from './watch/togetherReporter.js';
import { createDeviceChannel } from './transport/createDeviceChannel.js';
import { holdCardChannel } from './transport/startCardChannel.js';
import { launchCardService } from './headless/launchCardService.js';
import { loadDeviceConfig } from './config.js';
import { resolveDeviceId } from './deviceId.js';

const QUEUE_POLL_MS = 1000;

/** The namespace Content Personalization files Wick's own programme ids under. */
const CONTENT_ID_NAMESPACE = 'wick';

type Screen =
  | { readonly kind: 'pairing'; readonly info?: PairingStartResponse }
  | { readonly kind: 'ready'; readonly token: DeviceToken };

/**
 * Whether Wick is the app on screen. Vega tells an app it is leaving the
 * screen and stops its JavaScript a few seconds later (FL-022), so the
 * `background` event is the last chance to hand over to the card service.
 */
function useOnScreen(): boolean {
  const [onScreen, setOnScreen] = React.useState(AppState.currentState !== 'background');
  React.useEffect(() => {
    const subscription = AppState.addEventListener('change', (state) => setOnScreen(state !== 'background'));
    return () => subscription.remove();
  }, []);
  return onScreen;
}

export default function App(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, KeplerFileSystem),
    [config],
  );
  const store = React.useMemo(() => new QueueStore(KeplerFileSystem), []);
  const breakController = React.useMemo(() => new BreakController(), []);

  const [screen, setScreen] = React.useState<Screen | null>(null);
  const [card, setCard] = React.useState<QueuedCard | null>(null);
  /** A card that has had its two showings and waits on the home screen to be asked for. */
  const [waiting, setWaiting] = React.useState<QueuedCard | null>(null);
  /** The waiting card the resident opened. A ref as well: the tick below reads it between renders. */
  const openedId = React.useRef<string | null>(null);
  const playbackStore = React.useMemo(() => new PlaybackEventStore(KeplerFileSystem), []);
  const [watching, setWatching] = React.useState<Programme | null>(null);
  const [lastWatchedId, setLastWatchedId] = React.useState<string | undefined>(undefined);
  /**
   * The watch-together session her "Start the film" press began. Only that
   * press makes one, and it lasts for that showing of the film: it is gone
   * when she leaves the film or chooses anything from the home screen, so
   * the same film started again later is not followed by anyone.
   */
  const [together, setTogether] = React.useState<Together | null>(null);
  const togetherReporter = React.useMemo(() => (together ? new TogetherReporter(together) : null), [together]);
  /** M2: the door card whose live view is open over it. */
  const [liveFor, setLiveFor] = React.useState<string | null>(null);
  // Bumped on the way back from live view: remounting the card re-applies its
  // preferred focus, so OK works again at once rather than after an arrow key.
  const [returnedFromLive, setReturnedFromLive] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const deviceId = await resolveDeviceId(KeplerFileSystem);
        const token = await pairing.loadToken(deviceId);
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
  }, [pairing]);

  // The card channel lives here, in the process that renders, for as long
  // as Wick is on screen: the one QueueStore instance the render loop reads
  // below is the one the channel writes into — no disk hand-off (FL-013).
  //
  // Leaving the screen closes it, on purpose. The server then has only the
  // card service's background connection for this television and sends a
  // door card there, where it becomes a toast (headless/CardService.ts). A
  // connection left open by an app that is no longer running would swallow
  // the card instead.
  const token = screen?.kind === 'ready' ? screen.token : undefined;
  const onScreen = useOnScreen();
  React.useEffect(() => {
    if (!token || !onScreen) return;
    const held = holdCardChannel(store, token, createDeviceChannel, config);
    return () => held.stop();
  }, [token, onScreen, store, config]);

  // Once paired, and again each time Wick comes back on screen.
  React.useEffect(() => {
    if (!token || !onScreen) return;
    void launchCardService((uri) => Linking.openURL(uri));
  }, [token, onScreen]);

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
      let cards = await store.readAll();
      const picked = breakController.pickCard(cards, now);

      // Rule 3 of the Natural-Break Engine, made real: the server is told
      // when a card is really on screen, and a showing that ends unanswered
      // is counted. Two, and the card waits on the home screen instead.
      const showing = breakController.noteShown(picked, cards, now);
      if (showing.began) void store.enqueueOutbound({ t: 'card_shown', cardId: showing.began.id, at: now });
      if (showing.ended) {
        await store.countShowing(showing.ended.id);
        cards = await store.readAll();
      }

      // A waiting card the resident opened is shown until it is answered —
      // unless someone is at the door, which always comes first.
      const opened = openedId.current ? cards.find((c) => c.id === openedId.current) : undefined;
      if (openedId.current && !opened) openedId.current = null;
      const shown = picked?.urgency === 'DOOR' ? picked : opened ?? picked;
      if (cancelled) return;
      setCard(shown ?? null);
      setWaiting(breakController.waiting(cards, now) ?? null);

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
    (snapshot: PlayerSnapshot | undefined) => {
      const now = Date.now();
      breakController.setPlayback(snapshot, now);
      // Only for the film she started with someone, and only what the reporter thinks worth saying.
      const position = togetherReporter?.report(snapshot, now);
      if (position) void store.enqueueOutbound(position);
    },
    [breakController, togetherReporter, store],
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
    // The player says it has stopped as it unmounts (WatchScreen's cleanup, through the reporter it was given); then nobody is following.
    setTogether(null);
  }, []);

  const handleChoose = React.useCallback((programme: Programme) => {
    setTogether(null);
    setWatching(programme);
  }, []);

  const handleOpenWaiting = React.useCallback(() => {
    if (!waiting) return;
    openedId.current = waiting.id;
    setCard(waiting);
  }, [waiting]);

  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      if (card && card.id === cardId && opensLiveView(card.card, actionId)) setLiveFor(cardId);
      const film = card && card.id === cardId ? startsFilm(card.card, actionId, Date.now()) : undefined;
      const programme = film ? programmeById(film.programmeId) : undefined;
      if (film && programme) {
        setTogether(film.together ?? null);
        setWatching(programme);
      }
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
          companion={together && together.programmeId === watching.id ? together.withName : undefined}
          onExit={handleExitWatching}
        />
      ) : (
        <HomeScreen
          programmes={CATALOG}
          onChoose={handleChoose}
          cardVisible={card !== null}
          lastWatchedId={lastWatchedId}
          waiting={waiting && waiting.id !== card?.id ? waitingLine(waiting) : undefined}
          onOpenWaiting={handleOpenWaiting}
        />
      )}
      {/* Over the programme, at the bottom, never instead of it. */}
      {/* Not while live view is open: a card left underneath keeps the remote's
          focus, and OK then presses "Watch live" again instead of Back. */}
      {card && !liveFor ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CardRenderer key={`${card.id}:${returnedFromLive}`} card={card.card} onAction={handleAction} />
        </View>
      ) : null}
      {/* Back returns to the card as it was. */}
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

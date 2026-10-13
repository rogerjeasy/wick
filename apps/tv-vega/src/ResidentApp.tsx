/**
 * Wick on the resident's own television — everything that is hers.
 *
 * Mounted by App.tsx only for a television whose token names no kind
 * (family/mode.ts). The card channel, the card service, every DeviceEvent,
 * the Natural-Break Engine and what she watches all live in this component
 * and nowhere else, so a family member's own television — which App.tsx
 * gives family/FamilyApp.tsx instead — runs none of them.
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
 *
 * Hold for Sarah (packages/contracts/src/reach.ts): OK held for two seconds,
 * on the home screen or over a programme, asks the server for the card that
 * offers to have someone ring her. That card is hers to see at once, like
 * the Light card — she has just asked for it (home/reach.ts).
 *
 * The television speaks her language (packages/contracts/src/language.ts).
 * Which one comes from the home message and nowhere else, and is read below
 * where the rest of the home is read, once a second — so the app's own
 * words (words/words.ts) change within a second of the home message that
 * follows her yes. Everything
 * else on a card is the server's, and comes again in the new language
 * because the card channel asks for it (transport/startCardChannel.ts).
 * Where the disk works (Fire OS) the language is remembered, and nothing of
 * the home is drawn until it has been read back — so a relaunch does not
 * begin in English; on the Vega simulator, which keeps nothing, it is
 * English for the moment before the home message.
 */
import * as React from 'react';
import { Linking } from 'react-native';
import { BackHandler, StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import type { DeviceEvent, DeviceToken, HouseholdLanguage, QueuedCard } from '@wick/contracts';
import { safe } from '@wick/vega-calm-ui';
import { CardRenderer } from './cards/CardRenderer.js';
import { opensLiveView, removesCard, startsFilm } from './cards/cardActions.js';
import { LiveView } from './live/LiveView.js';
import { BreakController } from './break/BreakController.js';
import { QueueStore } from './headless/QueueStore.js';
import type { PlayerSnapshot } from './player/PlayerService.js';
import { PlaybackEventStore, toStoredPlaybackEvent } from './personalization/PlaybackEventStore.js';
import { CATALOG, calmPointsOf, programmeById, type Programme } from './catalog/catalog.js';
import { HomeScreen } from './home/HomeScreen.js';
import { backClosesOpened, waitingLine } from './home/waiting.js';
import { asking } from './home/asked.js';
import { lightLabel, lookedInLine, unaskedLightCards } from './home/light.js';
import { backAnswersReach, holdGuard, newestReachCard, reachOffersToPutAway } from './home/reach.js';
import { WatchScreen } from './watch/WatchScreen.js';
import { toPlaybackDeviceEvent } from './watch/playbackRecorder.js';
import { TogetherReporter, type Together } from './watch/togetherReporter.js';
import { createDeviceChannel } from './transport/createDeviceChannel.js';
import { holdCardChannel } from './transport/startCardChannel.js';
import { launchCardService } from './headless/launchCardService.js';
import type { DeviceConfig } from './config.js';
import { useOnScreen } from './useOnScreen.js';

const QUEUE_POLL_MS = 1000;

/**
 * How long the home may stay undrawn while the remembered language is read
 * back. A disk answers, or refuses, in a few milliseconds; one that does
 * neither must not keep the screen dark.
 */
const LANGUAGE_RECALL_WAIT_MS = 1000;

/** The namespace Content Personalization files Wick's own programme ids under. */
const CONTENT_ID_NAMESPACE = 'wick';

export interface ResidentAppProps {
  /** The resident's television's token: one that names no kind. */
  readonly token: DeviceToken;
  readonly config: DeviceConfig;
}

export function ResidentApp({ token, config }: ResidentAppProps): React.JSX.Element {
  const store = React.useMemo(() => new QueueStore(KeplerFileSystem), []);
  const breakController = React.useMemo(() => new BreakController({ calmPointsOf }), []);

  const [card, setCard] = React.useState<QueuedCard | null>(null);
  /** A card that has had its two showings and waits on the home screen to be asked for. */
  const [waiting, setWaiting] = React.useState<QueuedCard | null>(null);
  /** The waiting card the resident opened. A ref as well: the tick below reads it between renders. */
  const openedId = React.useRef<string | null>(null);
  /**
   * What the home screen says beside its cards: her light in the window, and
   * who looked in (home/light.ts). Kept as the words themselves, worked out
   * on every tick, so they change at the moment the day ends and not only
   * when the screen is next drawn.
   */
  const [light, setLight] = React.useState<string | undefined>(undefined);
  const [lookedIn, setLookedIn] = React.useState<string | undefined>(undefined);
  /**
   * The language she chose, as the home says it (QueueStore.language) — or
   * null for the moment before this launch has read what the last one
   * remembered. Nothing of the home is drawn until then.
   */
  const [language, setLanguage] = React.useState<HouseholdLanguage | null>(null);
  /**
   * Her press on the light on the home screen. The card that answers it is
   * opened as soon as it comes — waited for from when her question leaves
   * the television, not from the press (home/asked.ts).
   */
  const lightAsked = React.useMemo(() => asking(), []);
  /**
   * Her last hold on OK. For a little while after her question has left,
   * the newest Reach card is the one on screen — the offer her hold brings,
   * or her request as it stands — until she answers it or lets it go.
   */
  const reachAsked = React.useMemo(() => asking(), []);
  /** The channel says when each of those two questions really left: the wait for its answer runs from then. */
  const questionLeft = React.useCallback(
    (event: DeviceEvent, at: number) => {
      if (event.t === 'light') lightAsked.sent(event.at, at);
      else if (event.t === 'reach') reachAsked.sent(event.at, at);
    },
    [lightAsked, reachAsked],
  );
  /** Until her thumb is known to be off OK after a hold, the first press on a card is the thumb coming up (home/reach.ts). */
  const guard = React.useMemo(() => holdGuard(), []);
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

  // The card channel lives here, in the process that renders, for as long
  // as Wick is on screen: the one QueueStore instance the render loop reads
  // below is the one the channel writes into — no disk hand-off (FL-013).
  //
  // Leaving the screen closes it, on purpose. The server then has only the
  // card service's background connection for this television and sends a
  // door card there, where it becomes a toast (headless/CardService.ts). A
  // connection left open by an app that is no longer running would swallow
  // the card instead.
  const onScreen = useOnScreen();
  React.useEffect(() => {
    if (!onScreen) return;
    const held = holdCardChannel(store, token, createDeviceChannel, config, undefined, questionLeft);
    return () => held.stop();
  }, [token, onScreen, store, config, questionLeft]);

  // Once paired, and again each time Wick comes back on screen.
  React.useEffect(() => {
    if (!onScreen) return;
    void launchCardService((uri) => Linking.openURL(uri));
  }, [token, onScreen]);

  // The first look below sets the language as soon as the disk has been
  // read. This is only for a disk that never answers.
  React.useEffect(() => {
    const giveUp = setTimeout(() => setLanguage((known) => known ?? store.language()), LANGUAGE_RECALL_WAIT_MS);
    return () => clearTimeout(giveUp);
  }, [store]);

  React.useEffect(() => {
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
      if (showing.began) {
        void store.enqueueOutbound({ t: 'card_shown', cardId: showing.began.id, at: now });
        // The server counts this showing from now; if the card is sent again before it ends, it is not counted twice.
        await store.beginShowing(showing.began.id);
      }
      if (showing.ended) {
        await store.countShowing(showing.ended.id);
        cards = await store.readAll();
      }

      // Her light: the card that answers her press is hers to see at once,
      // wherever a break is. One she did not ask for is put away unseen.
      const light = cards.find((c) => c.card.type === 'LIGHT');
      if (light && lightAsked.waiting(now)) {
        openedId.current = light.id;
        lightAsked.done();
      }
      const unasked = unaskedLightCards(cards, openedId.current);
      if (unasked.length > 0) {
        for (const id of unasked) await store.remove(id);
        cards = await store.readAll();
      }

      // Hold for Sarah: what her hold brings is hers to see at once, and an
      // offer she is not looking at is put away rather than left for a break.
      const reach = newestReachCard(cards);
      if (reach && reachAsked.waiting(now)) openedId.current = reach.id;
      const offers = reachOffersToPutAway(cards, openedId.current);
      if (offers.length > 0) {
        for (const id of offers) await store.remove(id);
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
      const home = store.readHome();
      // Her language, as the home says it: read here, so the app's own words change at the next look after she says yes.
      const language = store.language();
      setLanguage(language);
      setLight(lightLabel(home, now, language));
      // The server's sentence, already in her language.
      setLookedIn(lookedInLine(home, now));

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
  }, [token, store, breakController]);

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

  // The light on the home screen: ask for the card that says how it stands.
  const handleOpenLight = React.useCallback(() => {
    const at = Date.now();
    lightAsked.asked(at);
    void store.enqueueOutbound({ t: 'light', at });
  }, [store, lightAsked]);

  // OK held for two seconds: ask for the card that offers to have someone ring her.
  const handleHold = React.useCallback(() => {
    const at = Date.now();
    reachAsked.asked(at);
    guard.held(at);
    void store.enqueueOutbound({ t: 'reach', at });
  }, [store, guard, reachAsked]);

  // OK came up: after a hold, the card that arrives may now be pressed.
  const handleKeyUp = React.useCallback(() => guard.released(Date.now()), [guard]);

  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      // Her thumb coming up from the hold, not a press: nothing is pressed, nothing is sent.
      if (guard.swallows(Date.now())) return;
      if (card && card.id === cardId && opensLiveView(card.card, actionId)) setLiveFor(cardId);
      const film = card && card.id === cardId ? startsFilm(card.card, actionId, Date.now()) : undefined;
      const programme = film ? programmeById(film.programmeId) : undefined;
      if (film && programme) {
        setTogether(film.together ?? null);
        setWatching(programme);
      }
      // Any answer on the card her hold brought ends the little while in which the newest one is brought forward.
      if (card && card.id === cardId && card.card.type === 'REACH') reachAsked.done();
      if (card && card.id === cardId && removesCard(card.card, actionId)) {
        void store.remove(cardId);
        setCard(null);
      }
      // The outbox is drained by whichever process holds the channel — this
      // one, since FL-014 (holdCardChannel above).
      void store.enqueueOutbound({ t: 'card_action', cardId, action: actionId, at: Date.now() });
    },
    [store, card, guard, reachAsked],
  );

  // Back on a waiting card the resident opened puts it back to waiting.
  // Registered again whenever what is on screen changes, so it is asked
  // before the screens underneath; it declines anything that is not its own.
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (!backClosesOpened({ openedId: openedId.current, shownId: card?.id ?? null, liveOpen: liveFor !== null })) return false;
      // On the card her hold brought, Back is an answer: an offer or a request left half read would come back at the next break (home/reach.ts).
      const reachAnswer = backAnswersReach(card?.card);
      if (card && reachAnswer) {
        handleAction(card.id, reachAnswer);
        return true;
      }
      openedId.current = null;
      setCard(null);
      return true;
    });
    return () => sub.remove();
  }, [card, liveFor, handleAction]);

  // Not yet known which language to say it in: a moment, at launch. Nothing is drawn in the wrong one.
  if (language === null) return <View style={styles.unlit} />;

  return (
    <View style={styles.screen}>
      {watching ? (
        <WatchScreen
          programme={watching}
          language={language}
          onSnapshot={handleSnapshot}
          onPlaybackEvent={handlePlaybackEvent}
          cardVisible={card !== null}
          held={breakController.holdsProgramme(card ?? undefined)}
          suspended={liveFor !== null}
          companion={together && together.programmeId === watching.id ? together.withName : undefined}
          onHold={handleHold}
          onHoldEnd={handleKeyUp}
          onExit={handleExitWatching}
        />
      ) : (
        <HomeScreen
          language={language}
          programmes={CATALOG}
          onChoose={handleChoose}
          cardVisible={card !== null}
          lastWatchedId={lastWatchedId}
          waiting={waiting && waiting.id !== card?.id ? waitingLine(waiting, language) : undefined}
          onOpenWaiting={handleOpenWaiting}
          light={light}
          onOpenLight={handleOpenLight}
          lookedIn={lookedIn}
          onHold={handleHold}
          onKeyUp={handleKeyUp}
        />
      )}
      {/* Over the programme, at the bottom, never instead of it. */}
      {/* Not while live view is open: a card left underneath keeps the remote's
          focus, and OK then presses "Watch live" again instead of Back. */}
      {card && !liveFor ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CardRenderer key={`${card.id}:${returnedFromLive}`} card={card.card} language={language} onAction={handleAction} />
        </View>
      ) : null}
      {/* Back returns to the card as it was. */}
      {liveFor ? (
        <LiveView
          pairingApiUrl={config.pairingApiUrl}
          jwt={token.jwt}
          cardId={liveFor}
          language={language}
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
  // The home screen's own ground, with nothing on it yet.
  unlit: {
    flex: 1,
    backgroundColor: safe.ground,
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

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
 *
 * The mantelpiece (packages/contracts/src/mantel.ts). A picture the family
 * sends is a card like any note. What she keeps is opened from the home
 * screen (mantel/MantelScreen.tsx): a screen she asked for, so a note that
 * becomes showable while it is open waits until she leaves it, and the
 * door comes over it at once. And when the home screen has sat untouched
 * for a few minutes her pictures fill it (mantel/IdleScreen.tsx) — worked
 * out in the one-second look below from a pure rule (mantel/idle.ts), with
 * no timer of its own. It makes nothing disappear and delays nothing: the
 * look picks cards exactly as before underneath it, and a card that can be
 * shown ends it. Any key ends it too, and that key press does nothing
 * else: every key is heard here, in one place, and only listened to.
 *
 * Read to me (packages/contracts/src/speech.ts). While a card is on screen
 * Play asks for it to be read aloud (read/reading.ts) — the one thing a key
 * heard here does. On the home screen, and on the door's card over a film
 * that is playing, Play again stops the reading, and the film is never
 * paused by it. Over a note that is holding the film Play is the card's
 * once: the first reads the note, and the next is her way back to the film
 * as Play there always was — the film goes on and the note is put away —
 * whether the reading is still going, is over, or never started
 * (watch/remoteKeys.ts playIsTheCards). Only when she asks: nothing here
 * ever starts a reading by itself. And where reading cannot work the mark
 * of the key is not drawn and Play is the film's from the first press.
 *
 * Easier to see (seeing/seeing.ts). A pill on the home screen opens its
 * card, drawn here like any card and held to the same one second. Its
 * presses change the whole television through the provider at the root
 * (seeing/SeeingProvider.tsx). A card from the server comes over it, and
 * it is there again when that card has gone.
 *
 * The platform's screen reader (VoiceView). When it is on, each card that
 * comes on screen is announced once (read/announce.ts); her pictures never
 * fill an idle home screen — a slideshow is moving content, and the reader
 * would speak over it (mantel/idle.ts); and the mark of the Play key is not
 * drawn, since the reader already speaks the card. Play itself still reads.
 */
import * as React from 'react';
import { Linking } from 'react-native';
import { BackHandler, StyleSheet, View, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import type { DeviceEvent, DeviceToken, HomeState, HouseholdLanguage, MantelItem, QueuedCard } from '@wick/contracts';
import { announce, useCalmStyles, useScreenReaderEnabled, type CalmTheme } from '@wick/vega-calm-ui';
import { speechTextOf } from '@wick/contracts';
import { CardRenderer } from './cards/CardRenderer.js';
import { opensLiveView, removesCard, startsFilm } from './cards/cardActions.js';
import { askToStop, stopsWick } from './pairing/stop.js';
import { LiveView } from './live/LiveView.js';
import { BreakController } from './break/BreakController.js';
import { followScreen } from './break/followScreen.js';
import { QueueStore, type Mantel } from './headless/QueueStore.js';
import type { PlayerSnapshot } from './player/PlayerService.js';
import { PlaybackEventStore, toStoredPlaybackEvent } from './personalization/PlaybackEventStore.js';
import { CONTENT_ID_NAMESPACE, platformPlaybackReporter } from './personalization/report.js';
import { WatchActivity } from './personalization/watchActivity.js';
import { CATALOG, calmPointsOf, programmeById, type Programme } from './catalog/catalog.js';
import { homeBehind } from './home/behind.js';
import { HomeScreen } from './home/HomeScreen.js';
import { backClosesOpened, backOnShownCard, putAway, putsAway, waitingLine } from './home/waiting.js';
import { asking } from './home/asked.js';
import { okHeld } from './press/held.js';
import { pressSettle } from './press/settle.js';
import { standingWatch } from './pairing/standing.js';
import type { RenewResult } from './pairing/PairingFlow.js';
import { lightLabel, lookedInLine, unaskedLightCards } from './home/light.js';
import { backAnswersReach, holdGuard, newestReachCard, reachOffersToPutAway } from './home/reach.js';
import { ReadHint } from './read/ReadHint.js';
import { Reader, type ReadingState } from './read/reading.js';
import { canRead, createSpeechPlayer } from './read/speechPlayer.js';
import { lowerFilm, type HasVolume } from './watch/filmVolume.js';
import { playIsTheCards, readCommand, type ReadCommand } from './watch/remoteKeys.js';
import { IdleScreen } from './mantel/IdleScreen.js';
import { MantelScreen } from './mantel/MantelScreen.js';
import { IDLE_OFF, blocksHome, idleOnBack, idleOnKey, lookAtIdle, type Idle } from './mantel/idle.js';
import { mantelToShow, offersMantel, overMantel, pictureRefresher } from './mantel/mantel.js';
import { words } from './words/words.js';
import { WatchScreen } from './watch/WatchScreen.js';
import { toPlaybackDeviceEvent } from './watch/playbackRecorder.js';
import { TogetherReporter, type Together } from './watch/togetherReporter.js';
import { createDeviceChannel } from './transport/createDeviceChannel.js';
import { holdCardChannel, type RunningCardChannel } from './transport/startCardChannel.js';
import { launchCardService } from './headless/launchCardService.js';
import type { DeviceConfig } from './config.js';
import { useOnScreen } from './useOnScreen.js';
import { announcer } from './read/announce.js';
import { SeeingCard } from './seeing/SeeingCard.js';
import { useSeeing } from './seeing/SeeingProvider.js';
import { SEEING_CARD, seeingActions, seeingCardShows } from './seeing/seeing.js';

const QUEUE_POLL_MS = 1000;

/**
 * How long the home may stay undrawn while the remembered language is read
 * back. A disk answers, or refuses, in a few milliseconds; one that does
 * neither must not keep the screen dark.
 */
const LANGUAGE_RECALL_WAIT_MS = 1000;

export interface ResidentAppProps {
  /** The resident's television's token: one that names no kind. */
  readonly token: DeviceToken;
  readonly config: DeviceConfig;
  /**
   * How to learn that the family has disconnected this television
   * (pairing/standing.ts): the question to put to the pairing service, what
   * to do when the answer is "no longer connected", and — when the service
   * has only just handed this token over — when that was. And where to
   * write down a fresh token taken in its place (`keep`).
   */
  readonly standing?: {
    readonly ask: (held: DeviceToken) => Promise<RenewResult>;
    readonly onGone: () => void;
    readonly keep: (fresh: DeviceToken) => Promise<void>;
    readonly since?: number;
  };
}

export function ResidentApp({ token, config, standing }: ResidentAppProps): React.JSX.Element {
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
  /** The home, as the server last said it: for what the home screen offers beside its films. */
  const [home, setHome] = React.useState<HomeState>({});
  /**
   * Her mantelpiece (packages/contracts mantel.ts), as the server last
   * answered this television's asking — kept in memory only: the addresses
   * in it are written nowhere.
   */
  const [mantel, setMantel] = React.useState<Mantel | undefined>(undefined);
  /** She has it open, and since when: what is shown is the answer to that opening (mantel/mantel.ts). */
  const [mantelOpen, setMantelOpen] = React.useState(false);
  const [mantelOpenedAt, setMantelOpenedAt] = React.useState(0);
  /** When the server was last asked for it, so it is not asked every second. */
  const mantelAskedAt = React.useRef<number | null>(null);
  /**
   * The idle screen (mantel/idle.ts): off, on, or ending — a key has ended
   * it and has not yet come up. A ref as well: the look and the key handler
   * read it between renders.
   */
  const [idle, setIdle] = React.useState<Idle>(IDLE_OFF);
  const idleNow = React.useRef<Idle>(IDLE_OFF);
  /** The picture the idle screen has up. */
  const [idleItem, setIdleItem] = React.useState<MantelItem | undefined>(undefined);
  /** Pictures of the current answer whose address did not load on the idle screen, which has no words to say so. */
  const idleFailed = React.useRef<{ readonly receivedAt: number | undefined; readonly ids: readonly string[] }>({ receivedAt: undefined, ids: [] });
  /** The last key press, or the last moment the home screen was not quiet: what the few idle minutes are counted from. */
  const lastActiveAt = React.useRef(Date.now());
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
  /**
   * A card's buttons take no press in the card's first second on screen
   * (press/settle.ts): a second OK meant for the card before must not
   * answer one she has not read. Told which card is on screen as it is
   * drawn — by its id, so the same card drawn again stays live.
   */
  const settle = React.useMemo(() => pressSettle(), []);

  const playbackStore = React.useMemo(() => new PlaybackEventStore(KeplerFileSystem), []);
  // Watch Activity for the platform (Content Personalization): when, by Amazon's rules, and the report itself.
  const watchActivity = React.useMemo(() => new WatchActivity(), []);
  const reportPlayback = React.useMemo(() => platformPlaybackReporter(), []);
  const tellPlatform = React.useCallback(
    (snapshot: PlayerSnapshot, at: number) => {
      const due = watchActivity.next(snapshot, at);
      if (due) reportPlayback(due);
    },
    [watchActivity, reportPlayback],
  );
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
  /** Easier to see: she opened its card, and the button on it she pressed last. */
  const [seeingOpen, setSeeingOpen] = React.useState(false);
  const [seeingFocus, setSeeingFocus] = React.useState<string | undefined>(undefined);
  const seeing = useSeeing();
  const styles = useCalmStyles(makeStyles);
  const seeingShown = seeingCardShows({ open: seeingOpen, card: card !== null, liveOpen: liveFor !== null });
  // Its one second, like any card's: counted from when it comes on screen, by its name.
  settle.appeared(card?.id ?? (seeingShown ? SEEING_CARD : null), Date.now());

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
  /** What is on screen now, for the look below, which runs between renders. */
  const screenReader = useScreenReaderEnabled();
  const screenNow = React.useRef({ watching: false, mantelOpen: false, liveOpen: false, onScreen: true, seeing: false, screenReader: false });
  screenNow.current = { watching: watching !== null, mantelOpen, liveOpen: liveFor !== null, onScreen, seeing: seeingShown, screenReader };
  /** The channel while it is held, for the one thing the app asks on it by itself: its cards again (below). */
  const cardChannel = React.useRef<RunningCardChannel | null>(null);
  /**
   * What the app hears of OK, whatever is on screen: since when it has been
   * down (press/held.ts). A key that went down in a film, or on a card, and
   * is still down when the home screen comes back presses nothing there
   * when it is let go.
   */
  const okKey = React.useMemo(() => okHeld(), []);
  // Back on screen: whatever card is there, she is looking at it afresh, and its first second starts again.
  // Behind another app: a key that was down comes up where Wick cannot hear it.
  const wasOnScreen = React.useRef(onScreen);
  React.useEffect(() => {
    if (onScreen && !wasOnScreen.current) settle.returned(Date.now());
    if (!onScreen) okKey.forget();
    wasOnScreen.current = onScreen;
  }, [onScreen, settle, okKey]);
  // A television the family has disconnected must not go on looking like
  // hers. Nothing tells it: the edge only refuses it. So while it is on
  // screen it asks the pairing service, now and then and whenever its
  // channel is in trouble, and on "no longer connected" it forgets what it
  // holds of the home and says so (App.tsx then shows the pairing screen).
  // No network, or a service in trouble, changes nothing.
  //
  // And a television that is still connected is handed a fresh token with
  // that answer. It is taken when the one in use is near its end — an hour
  // after launch, where the disk keeps none — and the channel is opened
  // again with it, before the edge ends the session the old one opened and
  // refuses every reconnection. Only the channel and live view go by the
  // token in use. A fresh token is not a new television: the watch, the
  // card service and "Wick is in front" (below) go by the one it was
  // launched with, so the edge is told nothing but the new connection.
  const [fresh, setFresh] = React.useState<{ readonly of: DeviceToken; readonly token: DeviceToken } | null>(null);
  const inUse = fresh?.of === token ? fresh.token : token;
  const standingNow = React.useRef(standing);
  standingNow.current = standing;
  const watch = React.useMemo(
    () =>
      standingWatch({
        held: { token, ...(standingNow.current?.since !== undefined ? { since: standingNow.current.since } : {}) },
        ask: (held) => standingNow.current?.ask(held) ?? Promise.resolve<RenewResult>('try_later'),
        onGone: () => void store.forget().then(() => standingNow.current?.onGone()),
        onFresh: (next) => {
          void standingNow.current?.keep(next);
          setFresh({ of: token, token: next });
        },
      }),
    // A new token from App.tsx is a new asking: the pairing service has just answered for it, or has yet to.
    [store, token],
  );
  React.useEffect(() => watch.onScreen(onScreen), [watch, onScreen]);
  React.useEffect(() => () => watch.stop(), [watch]);
  React.useEffect(() => {
    if (!onScreen) return;
    const held = holdCardChannel(store, inUse, createDeviceChannel, config, undefined, questionLeft, watch.trouble);
    cardChannel.current = held;
    return () => {
      cardChannel.current = null;
      held.stop();
    };
  }, [inUse, onScreen, store, config, questionLeft, watch]);

  // A picture card whose address is missing or has run out — a card may wait for days, an address lives an
  // hour. The server mints a new one each time it sends the card, so the cards are asked for again: once for a
  // card, and not again while that new address would still be good (mantel/mantel.ts).
  const pictureRefresh = React.useMemo(() => pictureRefresher(), []);
  const handlePictureFailed = React.useCallback(
    (cardId: string) => {
      if (pictureRefresh.due(cardId, Date.now())) cardChannel.current?.reconcile();
    },
    [pictureRefresh],
  );

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

  // On screen, or behind another app: the engine and the edge are told at
  // once, each time (break/followScreen.ts). JavaScript goes on running for
  // some seconds after Wick leaves the screen (FL-022), so being alive is
  // not being seen. Declared before the look below, so its first look
  // already knows. §4.3: `fg` is the Rhythm pillar's device-side input,
  // sent once per change.
  React.useEffect(() => {
    followScreen(breakController, (event) => void store.enqueueOutbound(event), onScreen, Date.now());
  }, [token, onScreen, store, breakController]);

  React.useEffect(() => {
    let cancelled = false;
    let lastSentBreakState: string | undefined;

    const tick = async () => {
      const now = Date.now();
      const on = screenNow.current;
      let cards = await store.readAll();
      // The mantelpiece is a screen she asked for: a note waits behind it, the door does not (mantel/mantel.ts).
      const picked = overMantel(breakController.pickCard(cards, now), on.mantelOpen);

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
      const waitingCard = breakController.waiting(cards, now);
      setWaiting(waitingCard ?? null);
      const home = store.readHome();
      setHome(home);
      // Her language, as the home says it: read here, so the app's own words change at the next look after she says yes.
      const language = store.language();
      setLanguage(language);
      setLight(lightLabel(home, now, language));
      // The server's sentence, already in her language.
      setLookedIn(lookedInLine(home, now));

      // Her mantelpiece, and the idle screen. Everything above has already happened exactly as it would without
      // them: this only decides whether her pictures may fill a home screen that has nothing else on it.
      const mantel = store.readMantel();
      setMantel(mantel);
      if (idleFailed.current.receivedAt !== mantel?.receivedAt) idleFailed.current = { receivedAt: mantel?.receivedAt, ids: [] };
      const seen = lookAtIdle({
        foreground: on.onScreen,
        watching: on.watching,
        mantelOpen: on.mantelOpen,
        liveOpen: on.liveOpen,
        // The Easier to see card is a card on screen like any other: the home is not quiet under it.
        cardShowing: shown !== undefined || on.seeing,
        waiting: waitingCard !== undefined,
        // A screen reader is on: no slideshow (mantel/idle.ts).
        screenReader: on.screenReader,
        home,
        now,
        idle: idleNow.current,
        lastActiveAt: lastActiveAt.current,
        mantel,
        askedAt: mantelAskedAt.current,
        failed: idleFailed.current.ids,
      });
      lastActiveAt.current = seen.lastActiveAt;
      if (seen.ask) {
        mantelAskedAt.current = now;
        void store.enqueueOutbound({ t: 'mantel', at: now });
      }
      if (seen.idle !== idleNow.current) {
        idleNow.current = seen.idle;
        setIdle(seen.idle);
      }
      setIdleItem(seen.picture);

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
      // Every snapshot, once a second: the platform hears changes, seeks and the 60-second beat.
      if (snapshot) tellPlatform(snapshot, now);
      else watchActivity.reset();
      // Only for the film she started with someone, and only what the reporter thinks worth saying.
      const position = togetherReporter?.report(snapshot, now);
      if (position) void store.enqueueOutbound(position);
    },
    [breakController, togetherReporter, store, tellPlatform, watchActivity],
  );

  // §4.3 and §3.3: the cloud hears about it now, over the channel this
  // process holds, and the platform hears it now too (personalization/
  // report.ts). The local store keeps it for the nightly flush.
  const handlePlaybackEvent = React.useCallback(
    (snapshot: PlayerSnapshot) => {
      const at = Date.now();
      void store.enqueueOutbound(toPlaybackDeviceEvent(snapshot, at));
      // Leaving the film comes only this way, as a stop: the platform hears it as EXIT.
      tellPlatform(snapshot, at);
      const stored = toStoredPlaybackEvent(snapshot, CONTENT_ID_NAMESPACE, at, true);
      // Best-effort: the VVD has no data root (FL-013), and a store that
      // cannot be written must not stop the programme.
      if (stored) playbackStore.append(stored).catch((e) => console.error('playback_event_store_failed', e));
    },
    [store, playbackStore, tellPlatform],
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

  // Easier to see: the pill opens its card; its first button holds the focus.
  const handleOpenSeeing = React.useCallback(() => {
    setSeeingFocus(undefined);
    setSeeingOpen(true);
  }, []);

  // OK held for two seconds: ask for the card that offers to have someone ring her.
  const handleHold = React.useCallback(() => {
    const at = Date.now();
    reachAsked.asked(at);
    guard.held(at);
    void store.enqueueOutbound({ t: 'reach', at });
  }, [store, guard, reachAsked]);

  // OK came up: after a hold, the card that arrives may now be pressed.
  const handleKeyUp = React.useCallback(() => guard.released(Date.now()), [guard]);

  // Read to me (read/reading.ts). One reader for the life of the app: her asking is sent like any event, the
  // player is the platform's, and a film that is playing is turned down for the voice and put back after it.
  const filmPlayer = React.useRef<HasVolume | null>(null);
  const handleFilmPlayer = React.useCallback((player: HasVolume | null) => {
    filmPlayer.current = player;
  }, []);
  /** How the reading stands, as the reader says it: a key needs to know whether one is under way. */
  const [readingState, setReadingState] = React.useState<ReadingState>('idle');
  /**
   * The card Play has already asked to have read, during this showing of
   * it. Over a film that card is holding, the next Play is then the film's
   * again. Forgotten when the card leaves the screen: another card, or the
   * same one shown again later, starts with reading.
   */
  const [askedFor, setAskedFor] = React.useState<string | null>(null);
  const reader = React.useMemo(
    () =>
      new Reader({
        onChange: setReadingState,
        createPlayer: createSpeechPlayer,
        ask: (cardId) => void store.enqueueOutbound({ t: 'read', cardId, at: Date.now() }),
        lowerFilm: () => {
          const film = filmPlayer.current;
          return lowerFilm(film, () => filmPlayer.current === film);
        },
      }),
    [store],
  );
  // The server's answer, as it comes: it is played only if it is the one asked for, for the card still on screen.
  React.useEffect(() => store.onSpeech((cardId, url) => reader.speech(cardId, url)), [store, reader]);
  // The card that can be read just now. None while the door camera is over the card, while Wick is behind
  // another app, or where reading cannot work — and a reading of any other card is over.
  const readable = canRead();
  const readingCard = readable && onScreen && card !== null && liveFor === null ? card.id : undefined;
  // Whose the next Play is (watch/remoteKeys.ts): the card's — or, over a film the card is holding, once Play
  // has asked for it, the film's again.
  const holdsFilm = watching !== null && breakController.holdsProgramme(card ?? undefined);
  const playReads = playIsTheCards({ card: readingCard, holdsFilm, askedFor });
  const reading = readingState !== 'idle';
  /** What a key needs to know, for the handler below, which runs between renders. The film's screen is given the same. */
  const keysNow = React.useRef<{ cardVisible: boolean; playReads: boolean; reading: boolean; card: string | undefined }>({ cardVisible: false, playReads: false, reading: false, card: undefined });
  keysNow.current = { cardVisible: card !== null, playReads, reading, card: readingCard };
  React.useEffect(() => {
    reader.showing(readingCard);
    setAskedFor((asked) => (asked !== null && asked !== readingCard ? null : asked));
  }, [reader, readingCard]);
  React.useEffect(() => {
    return () => reader.stop();
  }, [reader]);

  // Every key, wherever the focus is. It says she is there, which is what the idle screen waits for the
  // absence of; it is what ends the idle screen (mantel/idle.ts); and Play, while a card is on screen, asks
  // for the card to be read or ends the reading. Nothing else is done from a key heard here: what Play does
  // to the film is the film's screen's, which is given the same three things to decide by.
  useTVEventHandler((event) => {
    const now = Date.now();
    lastActiveAt.current = now;
    okKey.seen(event, now);
    const at = keysNow.current;
    const command = readCommand(event, at);
    // A key the idle screen takes — the one that ends it, and any other until that one is up — does nothing
    // else (mantel/idle.ts): it is not Play for a card that arrived in that moment.
    if (command && !blocksHome(idleNow.current)) {
      reader.press(command);
      // Play has now asked for this showing of this card: over a film it holds, the next Play is her way back to the film.
      if (command === 'toggle' && at.card !== undefined) setAskedFor(at.card);
    }
    const next = idleOnKey(idleNow.current, event, now);
    if (next !== idleNow.current) {
      idleNow.current = next;
      setIdle(next);
    }
  });

  // The platform's media controls, over her film (watch/mediaSession.ts): what a command has to say to the
  // reading is done as a key's is — the platform's Play/Pause reads a card as the key does, and carrying on
  // with the film ends a reading.
  const handleMediaRead = React.useCallback(
    (command: ReadCommand) => {
      lastActiveAt.current = Date.now();
      const at = keysNow.current;
      reader.press(command);
      if (command === 'toggle' && at.card !== undefined) setAskedFor(at.card);
    },
    [reader],
  );

  const askMantel = React.useCallback(() => {
    const at = Date.now();
    mantelAskedAt.current = at;
    void store.enqueueOutbound({ t: 'mantel', at });
  }, [store]);

  // The pill on the home screen: open her mantelpiece, and ask what is on it.
  const handleOpenMantel = React.useCallback(() => {
    setMantelOpenedAt(Date.now());
    setMantelOpen(true);
    askMantel();
  }, [askMantel]);

  const handleCloseMantel = React.useCallback(() => {
    setMantelOpen(false);
    lastActiveAt.current = Date.now();
  }, []);

  // "Take it down": the picture's id, and nothing else. The answer is the mantelpiece as it now stands.
  const handleTakeDown = React.useCallback(
    (photoId: string) => {
      void store.enqueueOutbound({ t: 'mantel_take_down', photoId, at: Date.now() });
    },
    [store],
  );

  // A picture on the idle screen did not load: it is left out, and — once for each answer — asked for again.
  const handleIdleFailed = React.useCallback(
    (photoId: string) => {
      const failed = idleFailed.current;
      if (failed.ids.includes(photoId)) return;
      idleFailed.current = { ...failed, ids: [...failed.ids, photoId] };
      if (failed.ids.length === 0) askMantel();
    },
    [askMantel],
  );

  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      // Her thumb coming up from the hold, not a press: nothing is pressed, nothing is sent.
      if (guard.swallows(Date.now())) return;
      // Nor is the key that ended the idle screen, coming up on a card that arrived in that moment.
      if (blocksHome(idleNow.current)) return;
      // Pressed in the card's first second: begun before she could have read it. Nothing happens, and the next press works.
      if (!settle.acts(Date.now())) return;
      if (card && card.id === cardId && opensLiveView(card.card, actionId)) setLiveFor(cardId);
      const film = card && card.id === cardId ? startsFilm(card.card, actionId, Date.now()) : undefined;
      const programme = film ? programmeById(film.programmeId) : undefined;
      if (film && programme) {
        setTogether(film.together ?? null);
        setWatching(programme);
      }
      // "Yes, delete everything": she stops Wick. Her television asks the Wick server itself; once her home is
      // closed it shows a new code, as a disconnected one does. Refused or unreachable, the page stays to try again.
      if (card && card.id === cardId && stopsWick(card.card, actionId)) {
        void askToStop(fetch, config.wickServerUrl, inUse.jwt).then((stopped) => {
          if (stopped === 'stopped') standing?.onGone();
          else console.warn('stop_wick_not_done', stopped);
        });
        return;
      }
      // Any answer on the card her hold brought ends the little while in which the newest one is brought forward.
      if (card && card.id === cardId && card.card.type === 'REACH') reachAsked.done();
      if (card && card.id === cardId && removesCard(card.card, actionId)) {
        // Her answer ends the showing, so the same card sent back — a picture, when her mantelpiece is full — is shown afresh.
        breakController.answered(cardId);
        void store.remove(cardId);
        setCard(null);
      }
      // "Later" on a note (Back): unanswered, it goes to her home screen's quiet line, and is not brought to her again by itself.
      if (card && card.id === cardId && putsAway(card.card, actionId)) {
        breakController.answered(cardId);
        void store.upsert(putAway(card));
        setCard(null);
      }
      // The outbox is drained by whichever process holds the channel — this
      // one, since FL-014 (holdCardChannel above).
      void store.enqueueOutbound({ t: 'card_action', cardId, action: actionId, at: Date.now() });
    },
    [store, card, guard, breakController, reachAsked, settle, config, inUse, standing],
  );

  // A press on the Easier to see card: held to the card's one second and the hold's thumb like any card's, then
  // the provider's to act on (seeing/SeeingProvider.tsx). Back closes it.
  const handleSeeingAction = React.useCallback(
    (actionId: string) => {
      const now = Date.now();
      if (guard.swallows(now)) return;
      if (blocksHome(idleNow.current)) return;
      if (!settle.acts(now)) return;
      setSeeingFocus(actionId);
      if (seeing.press(actionId)) setSeeingOpen(false);
    },
    [guard, settle, seeing],
  );

  // The platform's screen reader is told of each card once, as it comes on screen (read/announce.ts): the words
  // Play would read, in the order it would read them.
  const announcements = React.useMemo(() => announcer(), []);
  const announced = onScreen && liveFor === null ? (card ? card.id : seeingShown ? SEEING_CARD : null) : null;
  const announceWords = React.useRef<() => string>(() => '');
  announceWords.current = () => {
    if (card) return speechTextOf(card.card).join(' ');
    if (!language) return '';
    const say = words(language);
    return [say('seeing.headline'), say('seeing.detail'), ...seeingActions(seeing.preferences, say).map((action) => action.label)].join(' ');
  };
  React.useEffect(() => {
    if (announcements.shown(announced, screenReader)) announce(announceWords.current());
  }, [announcements, announced, screenReader]);

  // Back on a waiting card the resident opened puts it back to waiting.
  // Registered again whenever what is on screen changes, so it is asked
  // before the screens underneath; it declines anything that is not its own.
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      // Back ends the idle screen like any key, and goes no further: it must not leave Wick.
      const back = idleOnBack(idleNow.current);
      if (back.consumed) {
        idleNow.current = back.idle;
        setIdle(back.idle);
        lastActiveAt.current = Date.now();
        return true;
      }
      // Back on the Easier to see card puts it away, as its own Back does.
      if (seeingShown) {
        setSeeingOpen(false);
        return true;
      }
      if (!backClosesOpened({ openedId: openedId.current, shownId: card?.id ?? null, liveOpen: liveFor !== null })) {
        // A card that came to her (the door over her film, a note at a break): Back is its "Not now", or
        // nothing, and never reaches the film underneath or leaves Wick. The door camera keeps its own Back.
        if (!card || liveFor !== null) return false;
        const notNow = backOnShownCard(card.card);
        if (notNow) handleAction(card.id, notNow);
        return true;
      }
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
  }, [card, liveFor, handleAction, seeingShown]);

  // Not yet known which language to say it in: a moment, at launch. Nothing is drawn in the wrong one.
  if (language === null) return <View style={styles.unlit} />;
  const say = words(language);
  // The home screen behind whatever is over it (home/behind.ts): while a card is on screen, none of it is drawn.
  const behind = homeBehind({ card: card !== null || seeingShown, mantelOpen, idle });

  return (
    <View style={styles.screen}>
      {watching ? (
        <WatchScreen
          programme={watching}
          language={language}
          onSnapshot={handleSnapshot}
          onPlaybackEvent={handlePlaybackEvent}
          cardVisible={card !== null}
          playReads={playReads}
          reading={reading}
          onReadCommand={handleMediaRead}
          onPlayer={handleFilmPlayer}
          held={holdsFilm}
          suspended={liveFor !== null}
          companion={together && together.programmeId === watching.id ? together.withName : undefined}
          onHold={handleHold}
          onHoldEnd={handleKeyUp}
          onExit={handleExitWatching}
        />
      ) : (
        <HomeScreen
          drawn={behind.rows}
          inFront={onScreen}
          okDownSince={okKey.since}
          language={language}
          programmes={CATALOG}
          onChoose={handleChoose}
          cardVisible={!behind.reach}
          lastWatchedId={lastWatchedId}
          waiting={waiting && waiting.id !== card?.id ? waitingLine(waiting, language) : undefined}
          onOpenWaiting={handleOpenWaiting}
          light={light}
          onOpenLight={handleOpenLight}
          lookedIn={lookedIn}
          mantel={offersMantel(home) ? say('home.mantel') : undefined}
          onOpenMantel={handleOpenMantel}
          seeing={say('seeing.entry')}
          onOpenSeeing={handleOpenSeeing}
          onHold={handleHold}
          onKeyUp={handleKeyUp}
        />
      )}
      {/* Her mantelpiece, over the home screen she opened it from. */}
      {mantelOpen && !watching ? (
        <MantelScreen
          language={language}
          mantel={mantelToShow(mantel, mantelOpenedAt, Date.now())}
          cardVisible={card !== null}
          onAsk={askMantel}
          onTakeDown={handleTakeDown}
          onClose={handleCloseMantel}
          onHold={handleHold}
          onKeyUp={handleKeyUp}
        />
      ) : null}
      {/* Her pictures, when the home screen has sat untouched — and, unseen, until the key that ended them is up. */}
      {blocksHome(idle) ? (
        <IdleScreen language={language} visible={idle.phase === 'on'} item={idleItem} onFailed={handleIdleFailed} />
      ) : null}
      {/* Over the programme, at the bottom, never instead of it. */}
      {/* Not while live view is open: a card left underneath keeps the remote's
          focus, and OK then presses "Watch live" again instead of Back. */}
      {card && !liveFor ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CardRenderer key={`${card.id}:${returnedFromLive}`} card={card.card} language={language} onAction={handleAction} onPictureFailed={handlePictureFailed} />
          {/* The mark of the Play key: Play reads this card aloud. Only where it can — and not while a screen reader speaks the card already. */}
          {readable && !screenReader ? <ReadHint cardType={card.card.type} language={language} /> : null}
        </View>
      ) : null}
      {/* Easier to see, where any card goes. A card from the server comes over it; it is back when that card has gone. */}
      {seeingShown && !watching ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <SeeingCard language={language} focusId={seeingFocus} onAction={handleSeeingAction} />
        </View>
      ) : null}
      {/* Back returns to the card as it was. */}
      {liveFor ? (
        <LiveView
          pairingApiUrl={config.pairingApiUrl}
          jwt={inUse.jwt}
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

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
    },
    // The home screen's own ground, with nothing on it yet.
    unlit: {
      flex: 1,
      backgroundColor: t.palette.ground,
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

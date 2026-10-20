/**
 * A programme, playing — and the Natural-Break Engine's only source of truth.
 *
 * Every snapshot from the player goes to BreakController, which is what
 * holds a note from the family until the credits (or a long pause) and lets
 * it through then (§3.4, INV-5). A change of state also goes to the cloud as
 * a `playback` event and into the local store Content Personalization reads
 * (§3.3) — one signal, three uses.
 *
 * The remote, in full: Play/Pause or OK pauses and resumes; the skip keys or
 * left/right move 30 seconds; Back returns to the home screen. What the keys
 * mean is decided in remoteKeys.ts and tested there.
 *
 * And OK held for two seconds is not a press (hold.ts): it brings the card
 * that offers to ask someone to ring her (packages/contracts/src/reach.ts).
 * The pause or resume its first moment made is put back, so the programme
 * is as it was when the card arrives.
 *
 * Nothing here decides whether a card shows. This screen reports; the engine
 * decides; App.tsx renders the card over the picture.
 *
 * Over a card that can be read aloud, Play is the card's when the app says
 * so (packages/contracts/src/speech.ts, remoteKeys.ts): it reads the card,
 * and neither pauses nor resumes the programme here. Over a note that holds
 * the programme that is the first Play only — the next is the programme's
 * again, as Play there always was: the programme goes on and the note is
 * put away. The door's card holds the programme as a note does; a reading
 * over a film that is not held is turned down for it by the app, which is
 * told which player this screen has (`onPlayer`) and puts the sound back
 * when the reading is over.
 *
 * The film's bar (FilmBar.tsx, transport.ts): ↑ or ↓, a pause or a skip
 * bring the title, the time gone of the whole, how long is left and a
 * progress line, for four seconds of play — and for as long as the film is
 * paused. Up and Down are never dead over a film. Holding OK shows its
 * line from 0.4 s (press/HoldLine.tsx), and the bar steps aside for it.
 *
 * The platform's media controls reach the film too: "Alexa, pause", the
 * system's transport controls (mediaControls.ts). Each is decided by the
 * same rules as her keys (mediaSession.ts) and done here, on the one player:
 * a pause made by voice is a pause, and a note waiting for a break comes on
 * screen over it exactly as it does over a pause made by the key.
 */
import * as React from 'react';
import { BackHandler, StyleSheet, Text, View, useKeplerAppStateManager, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import { KeplerVideoView, VideoPlayer } from '@amazon-devices/react-native-w3cmedia';
import type { HouseholdLanguage } from '@wick/contracts';
import { useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import type { Programme } from '../catalog/catalog.js';
import { words } from '../words/words.js';
import { PlayerService, type PlayerSnapshot } from '../player/PlayerService.js';
import { PlaybackRecorder } from './playbackRecorder.js';
import { FilmPositions } from './resume.js';
import { HOLD_SHOWN_FROM_MS, isOkKey, okHold, type OkHold } from './hold.js';
import { TRANSPORT_SHOWN_MS, asksWhereFilmIs, transportShown } from './transport.js';
import { FilmBar } from './FilmBar.js';
import { HoldLine } from '../press/HoldLine.js';
import { seekTarget, watchCommand, type ReadCommand } from './remoteKeys.js';
import { startFilmSession, type FilmSession } from './mediaControls.js';
import { ECHO_WAIT_MS, keyEchoes, mediaOutcome, moveFilm, type MediaCommand } from './mediaSession.js';

export interface WatchScreenProps {
  readonly programme: Programme;
  /** The language she chose: what this screen says over the picture is said in it (words/words.ts). */
  readonly language: HouseholdLanguage;
  /** Every snapshot, once a second and on each change. */
  readonly onSnapshot: (snapshot: PlayerSnapshot | undefined) => void;
  /** Only the snapshots worth keeping: a change of state. */
  readonly onPlaybackEvent: (snapshot: PlayerSnapshot) => void;
  /** A card is on screen: OK and the arrows are the card's. */
  readonly cardVisible: boolean;
  /** Play is that card's for the next press: it reads the card (remoteKeys.ts playIsTheCards). Absent: Play is the programme's. */
  readonly playReads?: boolean | undefined;
  /** A reading has been asked for and is not over: a key that is only Pause stops it, and nothing else. */
  readonly reading?: boolean | undefined;
  /**
   * A media-session command (mediaSession.ts) has something to say to the
   * reading of the card on screen — the platform's Play/Pause, where it is
   * the remote's button, reads as the key does; anything that carries on
   * with the film ends a reading. The app's reader does it, as for a key.
   */
  readonly onReadCommand?: ((command: ReadCommand) => void) | undefined;
  /**
   * Which player the programme has — given when it is ready, and `null`
   * when it is let go. Only its volume is ever used by anyone else
   * (watch/filmVolume.ts).
   */
  readonly onPlayer?: ((player: { volume: number } | null) => void) | undefined;
  /**
   * A card that waited for a calm point, or for a pause, is on screen: the
   * programme waits on the cut while it is read, and goes on when it has
   * gone (break/NaturalBreakEngine.ts holdsProgramme). The door's card holds it too.
   */
  readonly held: boolean;
  /**
   * Whether the card that held the programme was put away by her, just now:
   * only then does the programme go on by itself. A door card that went by
   * itself while she was at the door leaves the film paused where it was.
   * Absent: the programme goes on whenever the card goes, as it always did.
   */
  readonly putAwayByHer?: (() => boolean) | undefined;
  /** Something else has the screen (the door camera, live): hold the programme. */
  readonly suspended: boolean;
  /**
   * Who is watching this programme along with her, from their own home
   * (packages/contracts/src/watch.ts). Said whenever this screen says
   * anything: nobody follows a film she has not been told they are following.
   */
  readonly companion?: string | undefined;
  /**
   * Where she left each film (resume.ts): the film goes on from its kept
   * place, and its place is kept as it is let go. The app's own, kept in
   * its file (ResidentApp.tsx), so the home screen can say "Carry on".
   */
  readonly positions?: FilmPositions | undefined;
  /** Whom holding OK would ask to ring her, when the television knows (press/HoldLine.tsx). */
  readonly holdName?: string | undefined;
  /** OK was held for two seconds, with nothing else on screen to take it (hold.ts). */
  readonly onHold?: (() => void) | undefined;
  /** OK came up again after such a hold. */
  readonly onHoldEnd?: (() => void) | undefined;
  readonly onExit: () => void;
}

type Status = 'opening' | 'playing' | 'paused' | 'failed';

/** Where she left each film, when the app gives no store of its own: for as long as the app runs (resume.ts). */
const sessionPositions = new FilmPositions();

export function WatchScreen(props: WatchScreenProps): React.JSX.Element {
  const { programme } = props;
  const styles = useCalmStyles(makeStyles);
  const [player, setPlayer] = React.useState<VideoPlayer | null>(null);
  const [status, setStatus] = React.useState<Status>('opening');

  // The handlers below are registered once; they read the current props here.
  const latest = React.useRef(props);
  latest.current = props;
  const playerRef = React.useRef<VideoPlayer | null>(null);
  /** This app's component, to which the platform sends its media commands. */
  const component = useKeplerAppStateManager().getComponentInstance();
  /** What a media-session command does, once the player is ready: set below, read by the session. */
  const obey = React.useRef<(command: MediaCommand, deltaMs?: number) => void>(() => undefined);

  /** Where the film has got to, as the player last said: for the film's bar. */
  const where = React.useRef({ positionMs: 0, durationMs: programme.durationMs });
  /** When she last asked where the film is — ↑, ↓, a skip, a pause (transport.ts) — or null for never. */
  const [askedAt, setAskedAt] = React.useState<number | null>(null);
  /** Draws the bar again: once a second while it is up, and when its four seconds are over. */
  const [, redraw] = React.useReducer((n: number) => n + 1, 0);
  const barUp = React.useRef(false);
  /** Since when OK has been down where it may be held, for the hold line; null when it is not. */
  const [holdSince, setHoldSince] = React.useState<number | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    // The app's kept places, or this session's.
    const filmPositions = latest.current.positions ?? sessionPositions;
    let service: PlayerService | undefined;
    let session: FilmSession | undefined;
    let last: PlayerSnapshot | undefined;
    const recorder = new PlaybackRecorder();
    const p = new VideoPlayer();

    const report = (snapshot: PlayerSnapshot) => {
      last = snapshot;
      latest.current.onSnapshot(snapshot);
      if (recorder.shouldRecord(snapshot)) latest.current.onPlaybackEvent(snapshot);
    };

    (async () => {
      await p.initialize();
      if (cancelled) return;
      p.addEventListener('error', () => {
        if (!cancelled) setStatus('failed');
      });
      p.src = programme.streamUrl;
      service = new PlayerService(p);
      service.onSnapshot((snapshot) => {
        if (cancelled) return;
        report(snapshot);
        where.current = { positionMs: snapshot.positionMs, durationMs: snapshot.durationMs > 0 ? snapshot.durationMs : programme.durationMs };
        if (barUp.current) redraw();
        session?.publish(snapshot);
        if (snapshot.state === 'PLAYING') setStatus('playing');
        else if (snapshot.state === 'PAUSED') setStatus((s) => (s === 'opening' ? s : 'paused'));
        // The programme is over: back to the home screen, where a held card
        // is already allowed (TV_SETTLED).
        else if (snapshot.state === 'STOPPED') latest.current.onExit();
      });
      service.start();
      playerRef.current = p;
      // Her film is the platform's media session from now: "Alexa, pause" reaches it.
      session = startFilmSession({ component, programme, command: (command, deltaMs) => obey.current(command, deltaMs) });
      service.load(programme.id, programme.creditsPositionMs);
      latest.current.onPlayer?.(p);
      setPlayer(p);
      await p.play();
      // Where she left it, if she did: not 0:00 again.
      const from = filmPositions.startAt(programme.id);
      if (from > 0) p.currentTime = from / 1000;
    })().catch(() => {
      if (!cancelled) setStatus('failed');
    });

    return () => {
      cancelled = true;
      service?.stop();
      session?.end();
      playerRef.current = null;
      latest.current.onPlayer?.(null);
      // Where it was left, for the next time she chooses it; a film watched to the credits starts again.
      if (last) filmPositions.stopped(programme.id, last.positionMs, programme.durationMs, programme.creditsPositionMs);
      // Leaving is a stop, wherever the programme had got to.
      if (last && last.state !== 'STOPPED') {
        const stopped: PlayerSnapshot = { ...last, state: 'STOPPED' };
        if (recorder.shouldRecord(stopped)) latest.current.onPlaybackEvent(stopped);
      }
      latest.current.onSnapshot(undefined);
      void p.deinitialize();
    };
    // The component is the app's own and does not change while it runs.
  }, [programme]);

  // Whether the OK press now under way paused or resumed the programme as it went down.
  const okToggled = React.useRef(false);
  const toggle = (p: VideoPlayer): void => {
    if (p.paused) void p.play();
    else p.pause();
  };
  const hold = React.useRef<OkHold | null>(null);
  hold.current ??= okHold({
    // OK is free to be held only while it is the programme's: not a card's, and not the door camera's.
    canHold: () => playerRef.current !== null && !latest.current.cardVisible && !latest.current.suspended,
    onHold: () => {
      const p = playerRef.current;
      // It was a hold, not a press: the programme goes back to how it was.
      if (p && okToggled.current) toggle(p);
      okToggled.current = false;
      latest.current.onHold?.();
    },
    onRelease: () => latest.current.onHoldEnd?.(),
    onBegin: (at) => setHoldSince(at),
    onEnd: () => setHoldSince(null),
  });
  React.useEffect(() => () => hold.current?.cancel(), []);

  // The media keys pressed, for telling a press heard a second time by the media session from a voice (mediaSession.ts).
  const echoes = React.useRef(keyEchoes()).current;

  useTVEventHandler((event) => {
    if (event.eventKeyAction === undefined || event.eventKeyAction === 0) echoes.key(event.eventType, Date.now());
    hold.current?.onEvent(event);
    if (isOkKey(event.eventType) && event.eventKeyAction === 1) okToggled.current = false;
    const p = playerRef.current;
    if (!p || latest.current.suspended) return;
    // ↑ or ↓: where is the film? The bar says.
    if (asksWhereFilmIs(event, { cardVisible: latest.current.cardVisible })) setAskedAt(Date.now());
    const command = watchCommand(event, { cardVisible: latest.current.cardVisible, playReads: latest.current.playReads, reading: latest.current.reading });
    if (command === 'toggle') {
      okToggled.current = isOkKey(event.eventType);
      toggle(p);
      setAskedAt(Date.now());
    } else if (command) {
      const target = seekTarget(p.currentTime * 1000, command, programme.durationMs);
      p.currentTime = target / 1000;
      // The bar says where the skip landed at once, not at the player's next word.
      where.current = { ...where.current, positionMs: target };
      setAskedAt(Date.now());
    }
  });

  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      if (latest.current.suspended) return false;
      latest.current.onExit();
      return true;
    });
    return () => sub.remove();
  }, []);

  // The door camera has its own sound; two soundtracks at once is noise.
  const { suspended } = props;
  const resumeAfter = React.useRef(false);
  React.useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    if (suspended) {
      resumeAfter.current = !p.paused;
      p.pause();
    } else if (resumeAfter.current) {
      resumeAfter.current = false;
      void p.play();
    }
  }, [suspended]);

  // A note in the middle of a programme, or the door: the film waits while the card is up.
  // If the resident had paused it themselves, it stays paused afterwards — and so it does
  // if the card went without her (putAwayByHer): she may still be at the door.
  const { held } = props;
  const resumeAfterCard = React.useRef(false);
  React.useEffect(() => {
    const p = playerRef.current;
    if (!p) return;
    if (held) {
      resumeAfterCard.current = !p.paused;
      p.pause();
    } else if (resumeAfterCard.current) {
      resumeAfterCard.current = false;
      if (latest.current.putAwayByHer?.() ?? true) void p.play();
    }
  }, [held]);

  // A command from the platform's media controls (mediaControls.ts): decided by the rules her keys obey
  // (mediaSession.ts), done to the same player in the same ways. Rebuilt on each render, so it reads what
  // is on screen now.
  const act = (command: MediaCommand, deltaMs: number | undefined): void => {
    const p = playerRef.current;
    if (!p) return;
    const now = latest.current;
    const outcome = mediaOutcome(
      command,
      { cardVisible: now.cardVisible, playReads: now.playReads, reading: now.reading, held: now.held, suspended: now.suspended },
      { paused: p.paused, positionMs: p.currentTime * 1000, durationMs: programme.durationMs },
      deltaMs,
    );
    if (outcome.reader) now.onReadCommand?.(outcome.reader);
    if (outcome.film) setAskedAt(Date.now());
    if (outcome.film) {
      moveFilm(p, outcome.film, () => {
        resumeAfterCard.current = false;
      });
    }
  };
  // A moment's wait first: the same press may also be arriving as a key, which has already been obeyed.
  obey.current = (command, deltaMs) => {
    const at = Date.now();
    setTimeout(() => {
      if (echoes.echoes(command, at)) console.info('media_command_echo', command);
      else act(command, deltaMs);
    }, ECHO_WAIT_MS);
  };

  // The hold line has the bottom of the screen from the moment it shows (0.4 s), and the bar steps aside for it.
  const [holdShown, setHoldShown] = React.useState(false);
  React.useEffect(() => {
    if (holdSince === null) {
      setHoldShown(false);
      return;
    }
    const timer = setTimeout(() => setHoldShown(true), Math.max(0, holdSince + HOLD_SHOWN_FROM_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [holdSince]);

  // A film's title is its name, and is never translated.
  const say = words(props.language);
  const notice = status === 'failed' ? say('watch.failed', { title: programme.title }) : status === 'opening' ? say('watch.starting', { title: programme.title }) : undefined;

  // The film's bar: when she asked where the film is, and while it is paused — never over a card, the door
  // camera, or the hold line (transport.ts).
  const ready = status === 'playing' || status === 'paused';
  const now = Date.now();
  const shown = !holdShown && transportShown({ paused: status === 'paused', cardVisible: props.cardVisible || suspended, ready, askedAt, now });
  barUp.current = shown;
  // Its four seconds are counted here: when they are over, it is drawn again, without itself.
  React.useEffect(() => {
    if (!shown || status === 'paused' || askedAt === null) return;
    const timer = setTimeout(redraw, Math.max(0, askedAt + TRANSPORT_SHOWN_MS - Date.now()) + 50);
    return () => clearTimeout(timer);
  }, [shown, status, askedAt]);

  return (
    <View style={styles.screen}>
      {player ? <KeplerVideoView videoPlayer={player} style={StyleSheet.absoluteFill} scalingmode="fit" /> : null}
      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} accessibilityLiveRegion="polite">
            {notice}
          </Text>
          {props.companion && status !== 'failed' ? <Text style={styles.noticeText}>{say('watch.companion', { name: props.companion })}</Text> : null}
        </View>
      ) : null}
      <FilmBar
        shown={shown}
        language={props.language}
        title={programme.title}
        positionMs={where.current.positionMs}
        durationMs={where.current.durationMs}
        paused={status === 'paused'}
        companion={props.companion}
        attribution={programme.attribution}
      />
      {/* Holding OK over the film: its line, from 0.4 s (press/HoldLine.tsx). */}
      <HoldLine since={holdSince} language={props.language} name={props.holdName} />
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    screen: {
      flex: 1,
      backgroundColor: '#000000',
    },
    notice: {
      position: 'absolute',
      left: 48,
      right: 48,
      bottom: 32,
      backgroundColor: t.palette.raisedHigh,
      borderRadius: 16,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
      paddingVertical: 16,
      paddingHorizontal: 24,
      gap: 4,
    },
    noticeText: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });

/**
 * The seat beside her film, on a family member's own television
 * (packages/contracts/src/familyTelevision.ts `FamilyTvSeat`).
 *
 * It asks the Wick server where her film is every FAMILY_TV_SEAT_EVERY_MS
 * while it is on screen, and its player keeps up with hers (seat.ts
 * `follow`): it plays when hers plays, stops where hers stops, and jumps
 * only when it has fallen more than a couple of seconds out.
 *
 * This television follows and never leads. There is NO pause, seek or skip
 * here: the play, pause, rewind and forward keys are not listened for at
 * all, and OK and the arrows do nothing while the film is on. Back leaves
 * the seat — the film goes on at hers, and the card that offers the seat is
 * still on the home screen. Nobody reaches her remote.
 *
 * And it tells nobody anything. The player here is the one the resident's
 * watch screen uses, and nothing else of that screen: no PlayerService, no
 * playback event, no Content Personalization, no reporter. Where this
 * picture has got to is read by the follow rule and by nothing else.
 *
 * At the credits the film is stopped and the one question is asked — once:
 * the server's sentence there is the question itself. When it is over, the
 * server's last sentence and one button back; the seat goes on asking, so
 * that sentence changes when it does (what each said, and hers when it
 * comes). It stops asking only when there is no seat any more.
 */
import * as React from 'react';
import { BackHandler, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { KeplerVideoView, VideoPlayer } from '@amazon-devices/react-native-w3cmedia';
import { FAMILY_TV_SEAT_EVERY_MS, type FamilyTvPress, type FamilyTvSeat } from '@wick/contracts';
import { CalmCard, assertContrast, fontSize, safe } from '@wick/vega-calm-ui';
import type { FamilyClient, SeatAnswer } from './familyClient.js';
import { ALL_RIGHT, SOMETHING_WAITS } from './familyScreen.js';
import { pressGuard } from './presses.js';
import { repeat } from './repeat.js';
import { asksAgain, follow, maySeek, seatNotice, seatSurface, seatView, type SeatView } from './seat.js';

export interface FamilySeatProps {
  readonly client: Pick<FamilyClient, 'seat'>;
  /** Whether Wick is the app on screen: the seat asks nothing while it is not. */
  readonly onScreen: boolean;
  /** Whether the card Back would show waits for an answer (familyScreen.ts `somethingWaits`). Given which card is the film's own. */
  readonly waiting: (seatCardId: string | undefined) => boolean;
  /** Back, or the one button once it is over. */
  readonly onLeave: () => void;
  /**
   * An answer to the question at the credits. Resolves with a sentence to
   * show here — the answer was not taken, or may not have arrived — or with
   * nothing: it was taken, and the seat's own next sentence says so.
   */
  readonly onAnswer: (press: FamilyTvPress) => Promise<string | undefined>;
  /** The server no longer lets this television, or this member, sit here. */
  readonly onRefused: (answer: Extract<SeatAnswer, { kind: 'notAllowed' | 'signedOut' }>) => void;
}

/** Where her film is, as last heard, and when that was heard on this television's clock. */
interface Heard {
  readonly playback: FamilyTvSeat['playback'] | undefined;
  readonly arrivedAt: number;
}

/** How often this television's player is held against hers. */
const KEEP_UP_EVERY_MS = 1000;

export function FamilySeat({ client, onScreen, waiting, onLeave, onAnswer, onRefused }: FamilySeatProps): React.JSX.Element {
  assertContrast(safe.ink, safe.raised);
  assertContrast(safe.inkDim, safe.raised);

  const [view, setView] = React.useState<SeatView>({ kind: 'opening' });
  /** An answer has been pressed: its buttons are gone at once, so OK twice is one answer. */
  const [answering, setAnswering] = React.useState(false);
  /** A sentence about that answer, shown until "All right" (familyScreen.ts `afterSeatAnswer`). */
  const [said, setSaid] = React.useState<string | undefined>(undefined);
  /** Whether that press is still out. The buttons do not come back before it and the seat have both answered. */
  const pressOut = React.useRef(false);
  const mounted = React.useRef(true);
  React.useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );
  const heard = React.useRef<Heard | undefined>(undefined);
  // The effects below are registered once; they read the newest props here.
  const latest = React.useRef({ onLeave, onRefused });
  latest.current = { onLeave, onRefused };

  // Asks while the seat is on screen; stops when it is left, or Wick is.
  React.useEffect(() => {
    if (!onScreen) {
      // Off the screen her film is not followed: what was last heard is no longer where it is.
      heard.current = undefined;
      return;
    }
    const asking = repeat({
      ask: () => client.seat(),
      everyMs: FAMILY_TV_SEAT_EVERY_MS,
      onAnswer: (answer) => {
        if (answer.kind === 'notAllowed' || answer.kind === 'signedOut') {
          latest.current.onRefused(answer);
          return 'stop';
        }
        if (answer.kind === 'seat') {
          heard.current = { playback: answer.seat?.playback, arrivedAt: Date.now() };
          // The seat as it stands after the answer: its buttons, if it still has any, are its own again.
          if (!pressOut.current) setAnswering(false);
        }
        setView((previous) => seatView(previous, answer));
        // Over or not, it goes on asking — the last sentence can change — until there is no seat any more.
        return asksAgain(answer) ? undefined : 'stop';
      },
    });
    return () => asking.stop();
  }, [client, onScreen]);

  // Back leaves the seat, whatever it is showing.
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      latest.current.onLeave();
      return true;
    });
    return () => sub.remove();
  }, []);

  // OK does nothing while the film is on, and somebody will press it to
  // find that out. A card that arrives here — the question at the credits
  // most of all — takes no press in its first second (presses.ts).
  const guard = React.useMemo(() => pressGuard(), []);
  guard.surface(seatSurface(view, said, answering), Date.now());
  const pressCounts = (): boolean => guard.cardActs(Date.now());

  const seat = view.kind === 'sitting' ? view.seat : undefined;
  const seatCardId = seat?.cardId ?? (view.kind === 'asked' ? view.cardId : undefined);
  const somethingWaits = waiting(seatCardId);
  const stream = seat?.stream;
  const [failed, setFailed] = React.useState(false);
  const handleFailed = React.useCallback(() => setFailed(true), []);
  // Another film, or the same one offered afresh, is another try.
  const streamUrl = stream?.url;
  React.useEffect(() => setFailed(false), [streamUrl]);

  const notice = seat ? (failed ? `${seat.film} will not play on this television just now. Press Back.` : seatNotice(seat)) : undefined;

  const handleAnswer = (press: FamilyTvPress): void => {
    if (pressOut.current || !pressCounts()) return;
    pressOut.current = true;
    setAnswering(true);
    void onAnswer(press)
      .catch(() => undefined)
      .then((sentence) => {
        pressOut.current = false;
        if (!mounted.current || sentence === undefined) return;
        // Not taken, or perhaps not sent: said here, and the question is there to answer again.
        setSaid(sentence);
        setAnswering(false);
      });
  };

  return (
    <View style={styles.screen}>
      {stream ? <SeatFilm key={stream.url} url={stream.url} durationMs={stream.durationMs} heard={heard} onFailed={handleFailed} /> : null}

      {/* One calm line, and no card: Back is the way to it. */}
      {somethingWaits ? (
        <View style={styles.waiting}>
          <Text style={styles.noticeText} accessibilityLiveRegion="polite">
            {SOMETHING_WAITS}
          </Text>
        </View>
      ) : null}

      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} accessibilityLiveRegion="polite">
            {notice}
          </Text>
          {stream?.attribution ? <Text style={styles.attribution}>{stream.attribution}</Text> : null}
        </View>
      ) : null}

      {said ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CalmCard key={`said:${said}`} headline={said} actions={[ALL_RIGHT]} onAction={() => pressCounts() && setSaid(undefined)} compact />
        </View>
      ) : null}

      {/* The question, once: at the credits the server's sentence is the question itself. */}
      {!said && view.kind === 'asked' ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CalmCard
            key={answering ? 'answering' : `asked:${view.answers.map((a) => a.id).join(',')}`}
            headline={view.question}
            actions={answering ? [] : view.answers}
            onAction={(action) => handleAnswer({ cardId: view.cardId, action })}
            compact
          />
        </View>
      ) : null}

      {/* The server's last sentence, redrawn when it changes; the button does not move, so the focus stays on it. */}
      {!said && view.kind === 'over' ? (
        <View style={styles.cardLayer} pointerEvents="box-none">
          <CalmCard key="over" headline={view.line} actions={[ALL_RIGHT]} onAction={() => pressCounts() && onLeave()} compact />
        </View>
      ) : null}
    </View>
  );
}

interface SeatFilmProps {
  readonly url: string;
  readonly durationMs: number;
  readonly heard: { readonly current: Heard | undefined };
  readonly onFailed: () => void;
}

/**
 * Her film on this television: the picture, and the one loop that holds it
 * against hers. Mounted only while there is a film to follow; unmounting
 * stops it and gives the player back.
 */
function SeatFilm({ url, durationMs, heard, onFailed }: SeatFilmProps): React.JSX.Element | null {
  const [player, setPlayer] = React.useState<VideoPlayer | null>(null);
  const failedWith = React.useRef(onFailed);
  failedWith.current = onFailed;

  React.useEffect(() => {
    let cancelled = false;
    let keepingUp: ReturnType<typeof setInterval> | undefined;
    let soughtAt: number | undefined;
    const p = new VideoPlayer();
    const failed = (): void => {
      if (!cancelled) failedWith.current();
    };

    const keepUp = (): void => {
      const now = Date.now();
      const last = heard.current;
      const step = follow(last?.playback, { arrivedAt: last?.arrivedAt ?? now, now }, { positionMs: p.currentTime * 1000, playing: !p.paused }, durationMs);
      if (step.seekToMs !== undefined && maySeek(p, soughtAt, now)) {
        soughtAt = now;
        p.currentTime = step.seekToMs / 1000;
      }
      // A play overtaken by a pause is turned away by the player, and is not a film that will not play: only its own 'error' says that.
      if (step.run === 'play') void p.play().catch(() => undefined);
      else if (step.run === 'pause') p.pause();
    };

    (async () => {
      await p.initialize();
      if (cancelled) return;
      p.addEventListener('error', failed);
      p.src = url;
      setPlayer(p);
      keepUp();
      keepingUp = setInterval(keepUp, KEEP_UP_EVERY_MS);
    })().catch(failed);

    return () => {
      cancelled = true;
      if (keepingUp !== undefined) clearInterval(keepingUp);
      void p.deinitialize();
    };
  }, [url, durationMs, heard]);

  return player ? <KeplerVideoView videoPlayer={player} style={StyleSheet.absoluteFill} scalingmode="fit" /> : null;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
  // Where the resident's watch screen says what it has to (watch/WatchScreen.tsx), to the dp.
  notice: {
    position: 'absolute',
    left: 48,
    bottom: 32,
    backgroundColor: safe.raised,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
    gap: 4,
  },
  // At the top, clear of the notice and of the question's card.
  waiting: {
    position: 'absolute',
    left: 48,
    top: 32,
    backgroundColor: safe.raised,
    borderRadius: 16,
    paddingVertical: 16,
    paddingHorizontal: 24,
  },
  noticeText: {
    color: safe.ink,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
  attribution: {
    color: safe.inkDim,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
  // The resident's card layer (ResidentApp.tsx), to the dp.
  cardLayer: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'flex-end',
    paddingHorizontal: 48,
    paddingBottom: 32,
  },
});

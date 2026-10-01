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
 * Nothing here decides whether a card shows. This screen reports; the engine
 * decides; App.tsx renders the card over the picture.
 */
import * as React from 'react';
import { BackHandler, StyleSheet, Text, View, useTVEventHandler } from '@amazon-devices/react-native-kepler';
import { KeplerVideoView, VideoPlayer } from '@amazon-devices/react-native-w3cmedia';
import { fontSize, safe } from '@wick/vega-calm-ui';
import type { Programme } from '../catalog/catalog.js';
import { PlayerService, type PlayerSnapshot } from '../player/PlayerService.js';
import { PlaybackRecorder } from './playbackRecorder.js';
import { seekTarget, watchCommand } from './remoteKeys.js';

export interface WatchScreenProps {
  readonly programme: Programme;
  /** Every snapshot, once a second and on each change. */
  readonly onSnapshot: (snapshot: PlayerSnapshot | undefined) => void;
  /** Only the snapshots worth keeping: a change of state. */
  readonly onPlaybackEvent: (snapshot: PlayerSnapshot) => void;
  /** A card is on screen: OK and the arrows are the card's. */
  readonly cardVisible: boolean;
  /** Something else has the screen (the door camera, live): hold the programme. */
  readonly suspended: boolean;
  readonly onExit: () => void;
}

type Status = 'opening' | 'playing' | 'paused' | 'failed';

export function WatchScreen(props: WatchScreenProps): React.JSX.Element {
  const { programme } = props;
  const [player, setPlayer] = React.useState<VideoPlayer | null>(null);
  const [status, setStatus] = React.useState<Status>('opening');

  // The handlers below are registered once; they read the current props here.
  const latest = React.useRef(props);
  latest.current = props;
  const playerRef = React.useRef<VideoPlayer | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    let service: PlayerService | undefined;
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
        if (snapshot.state === 'PLAYING') setStatus('playing');
        else if (snapshot.state === 'PAUSED') setStatus((s) => (s === 'opening' ? s : 'paused'));
        // The programme is over: back to the home screen, where a held card
        // is already allowed (TV_SETTLED).
        else if (snapshot.state === 'STOPPED') latest.current.onExit();
      });
      service.start();
      service.load(programme.id, programme.creditsPositionMs);
      playerRef.current = p;
      setPlayer(p);
      await p.play();
    })().catch(() => {
      if (!cancelled) setStatus('failed');
    });

    return () => {
      cancelled = true;
      service?.stop();
      playerRef.current = null;
      // Leaving is a stop, wherever the programme had got to.
      if (last && last.state !== 'STOPPED') {
        const stopped: PlayerSnapshot = { ...last, state: 'STOPPED' };
        if (recorder.shouldRecord(stopped)) latest.current.onPlaybackEvent(stopped);
      }
      latest.current.onSnapshot(undefined);
      void p.deinitialize();
    };
  }, [programme]);

  useTVEventHandler((event) => {
    const p = playerRef.current;
    if (!p || latest.current.suspended) return;
    const command = watchCommand(event, { cardVisible: latest.current.cardVisible });
    if (command === 'toggle') {
      if (p.paused) void p.play();
      else p.pause();
    } else if (command) {
      p.currentTime = seekTarget(p.currentTime * 1000, command, programme.durationMs) / 1000;
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

  const notice =
    status === 'failed'
      ? `${programme.title} will not play just now. Press Back.`
      : status === 'opening'
        ? `Starting ${programme.title}…`
        : status === 'paused' && !props.cardVisible && !suspended
          ? `Paused — ${programme.title}`
          : undefined;

  return (
    <View style={styles.screen}>
      {player ? <KeplerVideoView videoPlayer={player} style={StyleSheet.absoluteFill} scalingmode="fit" /> : null}
      {notice ? (
        <View style={styles.notice}>
          <Text style={styles.noticeText} accessibilityLiveRegion="polite">
            {notice}
          </Text>
          {status === 'paused' ? <Text style={styles.attribution}>{programme.attribution}</Text> : null}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: '#000000',
  },
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
});

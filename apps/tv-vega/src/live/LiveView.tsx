/**
 * Watch live (M2) — the front door camera, full screen, because the resident
 * asked for it. Back (the remote's key, or the one button) returns to the
 * door card underneath, which stays exactly as it was.
 *
 *   opening  "Opening the front door camera…"   start + wait for the first playlist (~6s)
 *   live     the picture, "Live from the front door · 42 seconds left"
 *   done     one plain sentence and Back — Ring's limit reached, or why there's no picture
 *
 * The picture is HLS over HTTPS through the app's own w3cmedia player: Vega
 * has no WebRTC, its WebView crashes on the VVD (FL-015), and the player
 * drops cleartext HLS silently (FL-016). The countdown is Ring's own session
 * limit (30s battery, 60s line power), which Ring's docs ask apps to show —
 * when it runs out the view says so and waits; nothing disappears on its own.
 *
 * The decisions (requests, waiting, wording) are in liveClient.ts and tested
 * there; this file renders them.
 */
import * as React from 'react';
import { BackHandler, Pressable, StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { KeplerVideoView, VideoPlayer } from '@amazon-devices/react-native-w3cmedia';
import { LIVE_FIRST_PICTURE_TIMEOUT_MS, type HouseholdLanguage, type LiveSessionResponse } from '@wick/contracts';
import { CalmCard, useCalmStyles, type CalmTheme } from '@wick/vega-calm-ui';
import { words } from '../words/words.js';
import { liveMessage, outcomeWhenPlayerStops, secondsLeft, startLiveSession, stopLiveSession, waitForPlaylist, type LiveOutcome } from './liveClient.js';

export interface LiveViewProps {
  readonly pairingApiUrl: string;
  readonly jwt: string;
  readonly cardId: string;
  /** The language she chose: every sentence here is this television's own (words/words.ts). */
  readonly language: HouseholdLanguage;
  readonly onClose: () => void;
}

type Phase =
  | { readonly kind: 'opening' }
  | { readonly kind: 'live'; readonly session: LiveSessionResponse; readonly player: VideoPlayer }
  | { readonly kind: 'done'; readonly outcome: LiveOutcome };

export function LiveView({ pairingApiUrl, jwt, cardId, language, onClose }: LiveViewProps): React.JSX.Element {
  const say = words(language);
  const styles = useCalmStyles(makeStyles);
  const back = React.useMemo(() => [{ id: 'back', label: say('live.back'), kind: 'primary' as const }], [say]);
  const [phase, setPhase] = React.useState<Phase>({ kind: 'opening' });
  const [now, setNow] = React.useState(Date.now());
  const session = React.useRef<LiveSessionResponse | null>(null);
  const player = React.useRef<VideoPlayer | null>(null);
  // The token this view was opened with is its token until it closes. The
  // television takes a fresh one when its own nears its end
  // (pairing/standing.ts), always with minutes to spare — far longer than a
  // live view lasts — and that must not start the picture again.
  const [openedWith] = React.useState(jwt);

  const release = React.useCallback(() => {
    const p = player.current;
    player.current = null;
    if (p) void p.deinitialize();
    const s = session.current;
    session.current = null;
    if (s) void stopLiveSession({ pairingApiUrl, jwt: openedWith, sessionId: s.sessionId });
  }, [pairingApiUrl, openedWith]);

  const close = React.useCallback(() => {
    release();
    onClose();
  }, [release, onClose]);

  // Start, wait for the first picture, play.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const started = await startLiveSession({ pairingApiUrl, jwt: openedWith, cardId });
      if (cancelled) return;
      if (!started.ok) {
        setPhase({ kind: 'done', outcome: started.reason });
        return;
      }
      session.current = started.session;

      const ready = await waitForPlaylist({
        url: started.session.playlistUrl,
        timeoutMs: LIVE_FIRST_PICTURE_TIMEOUT_MS,
        cancelled: () => cancelled,
      });
      if (cancelled) return;
      if (!ready) {
        release();
        setPhase({ kind: 'done', outcome: 'camera_unavailable' });
        return;
      }

      const p = new VideoPlayer();
      player.current = p;
      await p.initialize();
      // The player fails silently otherwise (FL-016, FL-018): a black
      // rectangle forever. Say it plainly instead, with Back.
      let hadPicture = false;
      p.addEventListener('playing', () => {
        hadPicture = true;
      });
      const stopped = () => {
        if (cancelled) return;
        release();
        setPhase({ kind: 'done', outcome: outcomeWhenPlayerStops({ hadPicture }) });
      };
      p.addEventListener('error', stopped);
      p.addEventListener('ended', stopped);
      if (cancelled) return;
      p.src = started.session.playlistUrl;
      await p.play();
      if (!cancelled) {
        // The countdown's clock was last set when the view opened; without
        // this the first live frame read ~7s high, then jumped.
        setNow(Date.now());
        setPhase({ kind: 'live', session: started.session, player: p });
      }
    })().catch(() => {
      if (!cancelled) {
        release();
        setPhase({ kind: 'done', outcome: 'camera_unavailable' });
      }
    });
    return () => {
      cancelled = true;
      release();
    };
  }, [pairingApiUrl, openedWith, cardId, release]);

  // Ring's limit, counted down once a second; at zero, say so and wait.
  React.useEffect(() => {
    if (phase.kind !== 'live') return;
    // Counts down Ring's own live-view limit on the live picture. No card is
    // on screen while it runs, and at zero it shows one and waits for her.
    // eslint-disable-next-line vega-calm-ui/no-auto-dismiss
    const timer = setInterval(() => {
      const t = Date.now();
      setNow(t);
      if (secondsLeft(phase.session.endsAt, t) === 0) {
        release();
        setPhase({ kind: 'done', outcome: 'ended' });
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [phase, release]);

  // The remote's Back key, in every phase.
  React.useEffect(() => {
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      close();
      return true;
    });
    return () => sub.remove();
  }, [close]);

  if (phase.kind === 'live') {
    return (
      <View style={styles.screen}>
        <KeplerVideoView videoPlayer={phase.player} style={StyleSheet.absoluteFill} scalingmode="fit" />
        <View style={styles.caption}>
          <Text style={styles.captionText} accessibilityLiveRegion="polite">
            {say('live.caption', { seconds: secondsLeft(phase.session.endsAt, now) })}
          </Text>
          <Pressable
            onPress={close}
            hasTVPreferredFocus
            accessibilityRole="button"
            accessibilityLabel={say('live.back')}
            style={({ focused }: { focused: boolean }) => [styles.back, focused ? styles.backFocused : styles.backRest]}
          >
            <Text style={styles.backText}>{say('live.back')}</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const headline = phase.kind === 'opening' ? say('live.opening') : liveMessage(phase.outcome, language);
  return (
    <View style={[styles.screen, styles.centred]}>
      <CalmCard headline={headline} actions={back} onAction={close} />
    </View>
  );
}

const makeStyles = (t: CalmTheme) =>
  StyleSheet.create({
    screen: {
      ...StyleSheet.absoluteFillObject,
      backgroundColor: t.palette.ground,
    },
    centred: {
      justifyContent: 'center',
      paddingHorizontal: 96,
    },
    // Bottom, inside the 5% TV safe area, on a solid band so it reads over any picture: the film's bar's surface.
    caption: {
      position: 'absolute',
      left: 48,
      right: 48,
      bottom: 32,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      gap: 24,
      backgroundColor: t.palette.raisedHigh,
      borderRadius: 16,
      borderWidth: t.cardEdgeDp,
      borderColor: t.palette.ink,
      paddingHorizontal: 24,
      paddingVertical: 16,
    },
    captionText: {
      flex: 1,
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
    back: {
      borderRadius: 12,
      paddingHorizontal: 32,
      paddingVertical: 8,
      backgroundColor: t.palette.ground,
    },
    // The focus is the theme's ring (vega-calm-ui theme.ts): thicker with higher contrast on, the same room at rest.
    backRest: t.ring(4).rest,
    backFocused: t.ring(4).focused,
    backText: {
      color: t.palette.ink,
      fontSize: t.fontSize('body'),
      lineHeight: t.lineHeight('body'),
    },
  });

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
import { LIVE_FIRST_PICTURE_TIMEOUT_MS, type LiveSessionResponse } from '@wick/contracts';
import { CalmCard, fontSize, safe } from '@wick/vega-calm-ui';
import { liveMessage, secondsLeft, startLiveSession, stopLiveSession, waitForPlaylist, type LiveOutcome } from './liveClient.js';

export interface LiveViewProps {
  readonly pairingApiUrl: string;
  readonly jwt: string;
  readonly cardId: string;
  readonly onClose: () => void;
}

type Phase =
  | { readonly kind: 'opening' }
  | { readonly kind: 'live'; readonly session: LiveSessionResponse; readonly player: VideoPlayer }
  | { readonly kind: 'done'; readonly outcome: LiveOutcome };

const BACK = [{ id: 'back', label: 'Back', kind: 'primary' as const }];

export function LiveView({ pairingApiUrl, jwt, cardId, onClose }: LiveViewProps): React.JSX.Element {
  const [phase, setPhase] = React.useState<Phase>({ kind: 'opening' });
  const [now, setNow] = React.useState(Date.now());
  const session = React.useRef<LiveSessionResponse | null>(null);
  const player = React.useRef<VideoPlayer | null>(null);

  const release = React.useCallback(() => {
    const p = player.current;
    player.current = null;
    if (p) void p.deinitialize();
    const s = session.current;
    session.current = null;
    if (s) void stopLiveSession({ pairingApiUrl, jwt, sessionId: s.sessionId });
  }, [pairingApiUrl, jwt]);

  const close = React.useCallback(() => {
    release();
    onClose();
  }, [release, onClose]);

  // Start, wait for the first picture, play.
  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const started = await startLiveSession({ pairingApiUrl, jwt, cardId });
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
      p.addEventListener('error', () => {
        if (cancelled) return;
        release();
        setPhase({ kind: 'done', outcome: 'camera_unavailable' });
      });
      if (cancelled) return;
      p.src = started.session.playlistUrl;
      await p.play();
      if (!cancelled) setPhase({ kind: 'live', session: started.session, player: p });
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
  }, [pairingApiUrl, jwt, cardId, release]);

  // Ring's limit, counted down once a second; at zero, say so and wait.
  React.useEffect(() => {
    if (phase.kind !== 'live') return;
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
            {`Live from the front door · ${secondsLeft(phase.session.endsAt, now)} seconds left`}
          </Text>
          <Pressable
            onPress={close}
            hasTVPreferredFocus
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={({ focused }: { focused: boolean }) => [styles.back, focused ? styles.backFocused : null]}
          >
            <Text style={styles.backText}>Back</Text>
          </Pressable>
        </View>
      </View>
    );
  }

  const headline = phase.kind === 'opening' ? 'Opening the front door camera…' : liveMessage(phase.outcome);
  return (
    <View style={[styles.screen, styles.centred]}>
      <CalmCard headline={headline} actions={BACK} onAction={close} />
    </View>
  );
}

const styles = StyleSheet.create({
  screen: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: safe.ground,
  },
  centred: {
    justifyContent: 'center',
    paddingHorizontal: 96,
  },
  // Bottom, inside the 5% TV safe area, on a solid band so it reads over any picture.
  caption: {
    position: 'absolute',
    left: 48,
    right: 48,
    bottom: 32,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    backgroundColor: safe.raised,
    borderRadius: 16,
    paddingHorizontal: 32,
    paddingVertical: 16,
  },
  captionText: {
    color: safe.ink,
    fontSize: fontSize('body'),
  },
  back: {
    borderRadius: 12,
    borderWidth: 4,
    borderColor: 'transparent',
    paddingHorizontal: 32,
    paddingVertical: 8,
    backgroundColor: safe.ground,
  },
  backFocused: {
    borderColor: safe.focus,
  },
  backText: {
    color: safe.ink,
    fontSize: fontSize('body'),
  },
});

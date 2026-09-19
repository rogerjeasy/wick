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
 * A real player is now attached (below) so BreakController.setPlayback gets
 * real snapshots instead of never firing — closing the gap
 * apps/tv-vega/src/break/BreakController.ts's header used to describe. What
 * is still open is SP-1 itself: whether a card composited on top of that
 * player's own active playback is actually visible and legible on real
 * hardware (FRICTION.md Open Slots, docs/WICK-TECHNICAL.md §14). This file
 * can't answer that — only a real device can. See SP1_SPIKE_CONTENT_URL
 * below for how to run the spike.
 */
import * as React from 'react';
import { StyleSheet, View } from '@amazon-devices/react-native-kepler';
import { KeplerFileSystem } from '@amazon-devices/kepler-file-system';
import { KeplerVideoView, VideoPlayer } from '@amazon-devices/react-native-w3cmedia';
import type { QueuedCard } from '@wick/contracts';
import { CardRenderer } from './cards/CardRenderer.js';
import { BreakController } from './break/BreakController.js';
import { PairingFlow, type PairingStartResponse } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { QueueStore } from './headless/QueueStore.js';
import { PlayerService } from './player/PlayerService.js';
import { loadDeviceConfig } from './config.js';
import { DEVICE_ID } from './deviceId.js';

const QUEUE_POLL_MS = 1000;

/**
 * SP-1 spike only (docs/WICK-TECHNICAL.md §14, FRICTION.md Open Slots).
 * Empty in every real build and every commit. To run the spike on a real
 * device: set this to a reachable video URL (e.g. a public-domain HLS/MP4
 * test stream), `kepler bundle`, `kepler run`, and watch what happens ~8s
 * after playback starts — a real DOOR card gets queued through the exact
 * production path (QueueStore -> BreakController -> CardRenderer) and
 * should appear in the lower third without interrupting playback. Revert
 * to '' before committing anything else. Answer goes in FRICTION.md, either
 * way.
 */
const SP1_SPIKE_CONTENT_URL = '';
const SP1_SPIKE_CARD_DELAY_MS = 8000;

type Screen = { readonly kind: 'pairing'; readonly info?: PairingStartResponse } | { readonly kind: 'ready' };

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
  const [videoPlayer, setVideoPlayer] = React.useState<VideoPlayer | null>(null);

  React.useEffect(() => {
    // SP-1 spike only: real pairing needs a browser round-trip against the
    // deployed API, which is not what this spike is testing (overlay-over-
    // playback, not pairing). Skip straight to 'ready' so the video/card
    // test isn't blocked on it.
    if (SP1_SPIKE_CONTENT_URL) {
      setScreen({ kind: 'ready' });
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const token = await pairing.loadToken(DEVICE_ID);
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

  React.useEffect(() => {
    if (screen?.kind !== 'ready' || !SP1_SPIKE_CONTENT_URL) return;
    let cancelled = false;
    let playerService: PlayerService | undefined;
    const player = new VideoPlayer();

    (async () => {
      await player.initialize();
      if (cancelled) {
        void player.deinitialize();
        return;
      }
      player.src = SP1_SPIKE_CONTENT_URL;
      playerService = new PlayerService(player);
      playerService.onSnapshot((snapshot) => breakController.setPlayback(snapshot, Date.now()));
      playerService.start();
      playerService.load('sp1-spike-content');
      await player.play();
      if (cancelled) return;
      setVideoPlayer(player);

      // Rule 1: a DOOR card renders immediately regardless of break state —
      // the minimal, fastest way to ask SP-1's actual question (is an
      // overlay visible on top of active playback) without waiting on
      // NaturalBreakEngine's AT_BREAK timing too.
      setTimeout(() => {
        if (cancelled) return;
        void store.upsert({
          id: 'sp1-spike-card',
          urgency: 'DOOR',
          card: {
            type: 'DOOR',
            id: 'sp1-spike-card',
            householdId: 'sp1-spike',
            correlationId: 'sp1-spike',
            createdAt: Date.now(),
            actions: [{ id: 'dismiss', kind: 'dismiss', label: 'Not now' }],
            line: 'SP-1 spike: this card should be visible without interrupting playback.',
          },
          queuedAt: Date.now(),
          shownCount: 0,
        });
      }, SP1_SPIKE_CARD_DELAY_MS);
    })();

    return () => {
      cancelled = true;
      playerService?.stop();
      setVideoPlayer(null);
      void player.deinitialize();
    };
  }, [screen, store, breakController]);

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
  if (screen.kind === 'pairing') {
    return screen.info ? <PairingScreen info={screen.info} /> : <PairingScreen />;
  }

  return (
    <View style={{ flex: 1 }}>
      {videoPlayer ? <KeplerVideoView videoPlayer={videoPlayer} style={StyleSheet.absoluteFill} scalingmode="fill" /> : null}
      {card ? <CardRenderer card={card.card} onAction={handleAction} /> : null}
    </View>
  );
}

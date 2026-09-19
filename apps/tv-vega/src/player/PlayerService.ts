/**
 * Wrapper over @amazon-devices/react-native-w3cmedia.
 *
 * Owning playback is what makes the Natural-Break Engine possible — this is not
 * incidental. The player is the only source of the position/credits signal that
 * decides when Wick is allowed to speak.
 *
 * Out-of-process playback (kepler-player-client/server) is deliberately deferred:
 * it survives UI crashes but is not worth the complexity in v1. See §3.6.
 *
 * Emits a snapshot at 1Hz and on every state-change event (§3.4's TODO). The
 * underlying player is HTMLMediaElement-shaped (MediaPlayer extends it —
 * ✅ verified against the installed react-native-w3cmedia .d.ts), so
 * `MediaElementLike` below is the small subset this module actually reads,
 * injected for testability the same way CardService.ts injects
 * KeplerFileSystem: a real MediaPlayer is a native TurboModule and cannot be
 * constructed outside a Vega runtime.
 *
 * Audio ducking (M1's TODO here) uses the player's own W3C `volume` — ✅
 * verified in the same .d.ts — rather than `@amazon-devices/keplerscript-audio-lib`,
 * which docs/WICK-TECHNICAL.md §3.6 itself marks ⚠️ C (signature unconfirmed)
 * and which is not present in node_modules at all. Ducking the player's own
 * volume achieves the same product requirement ("duck to -6dB, never mute")
 * with a primitive already confirmed to exist, and needs no native module
 * this repository cannot verify. Swap to the audio-control privilege later
 * if a real need for ducking *other* audio sources (not this player) shows up.
 */
import type { PlaybackStateName } from '@wick/contracts';

export type Unsubscribe = () => void;

/** The W3C HTMLMediaElement readyState levels this module cares about. */
const HAVE_FUTURE_DATA = 3;

export interface MediaElementLike {
  readonly currentTime: number;
  readonly duration: number;
  readonly paused: boolean;
  readonly ended: boolean;
  readonly readyState: number;
  volume: number;
  addEventListener(type: string, listener: () => void): void;
  removeEventListener(type: string, listener: () => void): void;
}

export interface PlayerSnapshot {
  readonly state: PlaybackStateName;
  readonly positionMs: number;
  readonly durationMs: number;
  readonly creditsPositionMs?: number;
  readonly contentId: string;
}

/**
 * Pure — the state/position math, independent of the interval/event
 * plumbing around it, so it is fully covered without a fake player's
 * addEventListener ever being exercised.
 */
export function deriveSnapshot(
  media: MediaElementLike,
  contentId: string,
  creditsPositionMs: number | undefined,
): PlayerSnapshot {
  const state: PlaybackStateName = media.ended
    ? 'STOPPED'
    : media.paused
      ? 'PAUSED'
      : media.readyState < HAVE_FUTURE_DATA
        ? 'BUFFERING'
        : 'PLAYING';

  return {
    state,
    positionMs: Math.round(media.currentTime * 1000),
    durationMs: Math.round((Number.isFinite(media.duration) ? media.duration : 0) * 1000),
    contentId,
    ...(creditsPositionMs !== undefined ? { creditsPositionMs } : {}),
  };
}

export interface PlayerServiceOptions {
  /** 1Hz per §3.4's TODO. */
  readonly sampleIntervalMs?: number;
  /** ~-6dB in linear amplitude. Never 0 — Principle "never mute" applies to ducking too. */
  readonly duckedVolume?: number;
  readonly setIntervalImpl?: typeof setInterval;
  readonly clearIntervalImpl?: typeof clearInterval;
}

const DEFAULT_SAMPLE_INTERVAL_MS = 1_000;
const DEFAULT_DUCKED_VOLUME = 0.5;
/** Events that mark a state change worth an out-of-cadence snapshot, beyond the 1Hz sample. */
const STATE_CHANGE_EVENTS = ['play', 'pause', 'playing', 'waiting', 'ended'] as const;

export class PlayerService {
  readonly #media: MediaElementLike;
  readonly #sampleIntervalMs: number;
  readonly #duckedVolume: number;
  readonly #setIntervalImpl: typeof setInterval;
  readonly #clearIntervalImpl: typeof clearInterval;

  readonly #handlers = new Set<(s: PlayerSnapshot) => void>();
  #contentId = '';
  #creditsPositionMs: number | undefined;
  #timer: ReturnType<typeof setInterval> | undefined;
  #boundStateChange: (() => void) | undefined;
  #unduckedVolume = 1;

  constructor(media: MediaElementLike, options: PlayerServiceOptions = {}) {
    this.#media = media;
    this.#sampleIntervalMs = options.sampleIntervalMs ?? DEFAULT_SAMPLE_INTERVAL_MS;
    this.#duckedVolume = options.duckedVolume ?? DEFAULT_DUCKED_VOLUME;
    this.#setIntervalImpl = options.setIntervalImpl ?? setInterval;
    this.#clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  }

  /** Associates the currently-loaded content's id and its platform-supplied "episode is ending" marker (§3.3). */
  load(contentId: string, creditsPositionMs?: number): void {
    this.#contentId = contentId;
    this.#creditsPositionMs = creditsPositionMs;
    this.#emit();
  }

  onSnapshot(handler: (s: PlayerSnapshot) => void): Unsubscribe {
    this.#handlers.add(handler);
    return () => this.#handlers.delete(handler);
  }

  start(): void {
    if (this.#timer) return;
    this.#boundStateChange = () => this.#emit();
    for (const type of STATE_CHANGE_EVENTS) this.#media.addEventListener(type, this.#boundStateChange);
    this.#timer = this.#setIntervalImpl(() => this.#emit(), this.#sampleIntervalMs);
  }

  stop(): void {
    this.#clearIntervalImpl(this.#timer);
    this.#timer = undefined;
    if (this.#boundStateChange) {
      for (const type of STATE_CHANGE_EVENTS) this.#media.removeEventListener(type, this.#boundStateChange);
      this.#boundStateChange = undefined;
    }
  }

  /** Duck to make room for a spoken card. Idempotent — ducking twice does not compound. */
  duck(): void {
    if (this.#media.volume > this.#duckedVolume) this.#unduckedVolume = this.#media.volume;
    this.#media.volume = this.#duckedVolume;
  }

  /** Never restores to 0 — a card that ducked into silence would defeat "never mute". */
  unduck(): void {
    this.#media.volume = this.#unduckedVolume > 0 ? this.#unduckedVolume : 1;
  }

  #emit(): void {
    const snapshot = deriveSnapshot(this.#media, this.#contentId, this.#creditsPositionMs);
    for (const handler of this.#handlers) handler(snapshot);
  }
}

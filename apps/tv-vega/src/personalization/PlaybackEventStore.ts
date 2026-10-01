/**
 * Local store of REAL playback events.
 *
 * §12.1 and check:no-mocks — runtime code uses real data. The Vega sample ships
 * ContentPersonalizationMocks wired into this path; it is deliberately absent
 * here and the CI guard keeps it that way.
 *
 * File-backed, same shape and same reason as headless/QueueStore.ts: this
 * store is read by the `content.dataRefresh.provider` service process
 * (handlers.ts, via DataRefreshService.ts) and written by
 * the `main` process's player (watch/WatchScreen.tsx). They share no JS
 * memory, so a persisted file is the only channel between them, exactly as
 * it is for the card queue.
 */
import type { FileSystemLike } from '../headless/QueueStore.js';
import type { PlayerSnapshot } from '../player/PlayerService.js';

/** The platform's own three reportable states (kepler-content-personalization's PlaybackState) — no BUFFERING, no INTERSTITIAL (Wick has neither ads nor a use for reporting transient buffering). */
export type ReportablePlaybackState = 'PLAYING' | 'PAUSED' | 'EXIT';

export interface StoredPlaybackEvent {
  readonly contentId: string;
  readonly contentIdNamespace: string;
  readonly playbackState: ReportablePlaybackState;
  readonly positionMs: number;
  readonly durationMs?: number;
  readonly creditsPositionMs?: number;
  readonly eventTimestampMs: number;
  /**
   * Set when the main process already sent this event over its own channel
   * as it happened (watch/WatchScreen.tsx). RhythmSyncTask skips these, so
   * one evening's viewing is not counted twice.
   */
  readonly sentLive?: boolean;
}

/**
 * Maps a live player snapshot to the platform's reportable vocabulary.
 * BUFFERING has no platform equivalent and is deliberately not persisted —
 * it is a transient device-local condition, not a customer playback state
 * the content personalization service has any use for.
 */
export function toStoredPlaybackEvent(
  snapshot: PlayerSnapshot,
  contentIdNamespace: string,
  eventTimestampMs: number,
  sentLive = false,
): StoredPlaybackEvent | undefined {
  const playbackState: ReportablePlaybackState | undefined =
    snapshot.state === 'PLAYING' ? 'PLAYING' : snapshot.state === 'PAUSED' ? 'PAUSED' : snapshot.state === 'STOPPED' ? 'EXIT' : undefined;
  if (!playbackState) return undefined;

  return {
    contentId: snapshot.contentId,
    contentIdNamespace,
    playbackState,
    positionMs: snapshot.positionMs,
    durationMs: snapshot.durationMs,
    eventTimestampMs,
    ...(snapshot.creditsPositionMs !== undefined ? { creditsPositionMs: snapshot.creditsPositionMs } : {}),
    ...(sentLive ? { sentLive: true } : {}),
  };
}

// Flat, directly under /data/ — see PairingFlow.ts's TOKEN_PATH comment for
// why (/wick/... failed on-device with a bare com.amazon.kepler.io.IoError).
const EVENTS_PATH = '/data/wick-playbackEvents.json';
const ENCODING = 'utf8';
/** On-device retention bound — this is a rolling recent-history buffer, not the timeline's system of record (that's DynamoDB, via RhythmSyncTask's nightly flush). */
const MAX_RETAINED = 500;

export class PlaybackEventStore {
  readonly #fs: FileSystemLike;
  readonly #path: string;

  constructor(fs: FileSystemLike, path: string = EVENTS_PATH) {
    this.#fs = fs;
    this.#path = path;
  }

  async append(event: StoredPlaybackEvent): Promise<void> {
    const all = await this.all();
    const next = [...all, event]
      .sort((a, b) => a.eventTimestampMs - b.eventTimestampMs)
      .slice(-MAX_RETAINED);
    await this.#write(next);
  }

  async since(sinceMs: number): Promise<readonly StoredPlaybackEvent[]> {
    return (await this.all()).filter((e) => e.eventTimestampMs >= sinceMs);
  }

  async all(): Promise<readonly StoredPlaybackEvent[]> {
    if (!(await this.#fs.exists(this.#path))) return [];
    const raw = await this.#fs.readFileAsString(this.#path, ENCODING);
    return raw ? (JSON.parse(raw) as readonly StoredPlaybackEvent[]) : [];
  }

  #write(events: readonly StoredPlaybackEvent[]): Promise<number> {
    return this.#fs.writeStringToFile(this.#path, JSON.stringify(events), ENCODING);
  }
}

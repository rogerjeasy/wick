/**
 * com.wick.tv.rhythmSyncTask — nightly batch upload of local playback events
 * to Timestream. The Rhythm pillar's device-side input.
 *
 * Coalesce: 10s window on device, flush on state change. No reason to be chatty.
 *
 * This task holds no channel of its own (manifest.toml puts it in no process
 * group with CardService — it is a `task`, not a `service`). It converts the
 * PlaybackEventStore backlog into outbound `playback` DeviceEvents and hands
 * them to QueueStore's outbox — the same outbox CardService's already-running
 * poll loop drains over whatever channel is open next. See §4.3.
 */
import type { FileSystemLike } from './QueueStore.js';
import { QueueStore } from './QueueStore.js';
import { PlaybackEventStore, type ReportablePlaybackState } from '../personalization/PlaybackEventStore.js';
import type { DeviceEvent, PlaybackStateName } from '@wick/contracts';

// Flat, directly under /data/ — see PairingFlow.ts's TOKEN_PATH comment for
// why (/wick/... failed on-device with a bare com.amazon.kepler.io.IoError).
const CURSOR_PATH = '/data/wick-rhythmSyncCursor.json';
const ENCODING = 'utf8';

interface TestDeps {
  readonly fs: FileSystemLike;
}

let testDeps: TestDeps | null = null;

/** Test-only seam — same shape as CardService.ts's, for the same reason. */
export function __setRhythmSyncTestDeps(deps: TestDeps | null): void {
  testDeps = deps;
}

function toPlaybackStateName(state: ReportablePlaybackState): PlaybackStateName {
  return state === 'EXIT' ? 'STOPPED' : state;
}

async function loadCursor(fs: FileSystemLike): Promise<number> {
  if (!(await fs.exists(CURSOR_PATH))) return 0;
  const raw = await fs.readFileAsString(CURSOR_PATH, ENCODING);
  return raw ? Number(raw) : 0;
}

export default async function doRhythmSync(): Promise<void> {
  // Lazy-imported on the real (non-test) path only — see CardService.ts's
  // identical comment.
  const fs = testDeps?.fs ?? (await import('@amazon-devices/kepler-file-system')).KeplerFileSystem;

  const playbackStore = new PlaybackEventStore(fs);
  const queue = new QueueStore(fs);

  const cursor = await loadCursor(fs);
  const events = await playbackStore.since(cursor);
  if (events.length === 0) return;

  for (const event of events) {
    const deviceEvent: DeviceEvent = {
      t: 'playback',
      state: toPlaybackStateName(event.playbackState),
      positionMs: event.positionMs,
      durationMs: event.durationMs ?? 0,
      ...(event.creditsPositionMs !== undefined ? { creditsPositionMs: event.creditsPositionMs } : {}),
      contentId: event.contentId,
      at: event.eventTimestampMs,
    };
    await queue.enqueueOutbound(deviceEvent);
  }

  const newest = Math.max(...events.map((e) => e.eventTimestampMs));
  // Best-effort, same as PairingFlow.pollUntilBound (FRICTION.md FL-013):
  // the events above are already enqueued for outbound delivery, so a
  // rejected cursor write must not undo that. Losing it just means the next
  // run re-reads from the old cursor and re-enqueues the same events —
  // QueueStore's outbox is not deduped, so that costs a duplicate upload,
  // not a crash or a silent stall. Recoverable is still the right trade
  // until the underlying /data issue is fixed.
  try {
    await fs.writeStringToFile(CURSOR_PATH, String(newest + 1), ENCODING);
  } catch (err) {
    console.error('rhythm_sync_cursor_persist_failed', err);
  }
}

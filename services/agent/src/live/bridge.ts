/**
 * The live bridge, productionised from SP-3 (spec §4.3, D5):
 *
 *   Ring WHEP ─WebRTC─▶ werift peer ─RTP/UDP─▶ ffmpeg ─HLS─▶ S3 live/<session>/ ─▶ CloudFront ─▶ TV
 *
 * Why a bridge at all: Vega has no WebRTC module and its WebView segfaults
 * on the VVD (FL-015), but its own w3cmedia player plays HLS — over HTTPS
 * only; cleartext is refused silently (FL-016).
 *
 * `startBridge` resolves as soon as Ring has accepted the offer (~1.5s), so
 * the caller can answer the television while the picture is still coming;
 * the first playlist follows ~5s later. It rejects with a LiveStartError the
 * view can say plainly when Ring won't stream. Everything after that runs
 * until Ring's limit, the resident's Back, Ring closing the connection, or
 * ffmpeg dying — and then everything is torn down, including the published
 * files (INV-3: no Ring media outlives the session here; the bucket's 24h
 * lifecycle is the backstop).
 */
import type { LiveRefusal } from '@wick/contracts';
import { RingApiError, type WhepSession } from '@wick/ring';
import { PLAYLIST, SDP_FILE, ffmpegArgs, rtpSdp, segmentsToUpload } from './hls.js';

export interface RtpPorts {
  readonly videoPort: number;
  readonly audioPort: number;
}

/** A receive-only WebRTC peer that forwards what it receives to the RTP ports (peer.ts). */
export interface Peer {
  /** Complete SDP offer, ICE gathered. */
  readonly offer: string;
  accept(answerSdp: string): Promise<void>;
  /** Settles when the connection closes or fails — Ring ending the session. */
  readonly ended: Promise<void>;
  close(): void;
}

export interface FfmpegProcess {
  readonly exited: Promise<number | null>;
  kill(): void;
}

export interface BridgeDeps {
  readonly openPeer: (ports: RtpPorts) => Promise<Peer>;
  /** Bound to the camera by the caller. */
  readonly startWhep: (offerSdp: string) => Promise<WhepSession>;
  readonly stopWhep: (sessionUrl: string) => Promise<void>;
  readonly workdir: {
    create(sessionId: string): Promise<string>;
    write(dir: string, name: string, text: string): Promise<void>;
    read(dir: string, name: string): Promise<Uint8Array | null>;
    remove(dir: string): Promise<void>;
  };
  readonly spawnFfmpeg: (args: string[]) => FfmpegProcess;
  readonly publish: {
    put(key: string, body: Uint8Array, contentType: string, cacheControl: string): Promise<void>;
    removePrefix(prefix: string): Promise<void>;
  };
  readonly now: () => number;
  readonly sleep: (ms: number) => Promise<void>;
  readonly log: (line: Record<string, unknown>) => void;
}

export interface BridgeRequest {
  readonly sessionId: string;
  readonly maxMs: number;
  readonly pollMs: number;
  readonly ports: RtpPorts;
}

export type BridgeEnd = 'limit' | 'stopped' | 'ring_ended' | 'ffmpeg_exited';

export interface RunningBridge {
  readonly sessionId: string;
  readonly endsAt: number;
  stop(): void;
  readonly done: Promise<BridgeEnd>;
}

export class LiveStartError extends Error {
  readonly refusal: LiveRefusal;
  constructor(refusal: LiveRefusal) {
    super(`live_start_${refusal}`);
    this.name = 'LiveStartError';
    this.refusal = refusal;
  }
}

/** Ring's answer, in the words the view will use. */
function refusalFor(err: unknown): LiveRefusal {
  return err instanceof RingApiError && err.code === 'UNSUPPORTED_HEVC_SDP_OFFER' ? 'camera_unsupported' : 'camera_unavailable';
}

export const livePrefix = (sessionId: string) => `live/${sessionId}/`;

const quietly = async (log: BridgeDeps['log'], what: string, fn: () => Promise<void> | void) => {
  try {
    await fn();
  } catch (err) {
    log({ level: 'warn', msg: 'live_cleanup_failed', what, err: err instanceof Error ? err.name : 'unknown' });
  }
};

export async function startBridge(req: BridgeRequest, deps: BridgeDeps): Promise<RunningBridge> {
  const { sessionId } = req;
  const prefix = livePrefix(sessionId);
  const dir = await deps.workdir.create(sessionId);
  await deps.workdir.write(dir, SDP_FILE, rtpSdp(req.ports));

  // ffmpeg listens before Ring sends anything, so the first keyframe isn't lost.
  const ffmpeg = deps.spawnFfmpeg(ffmpegArgs(dir));
  let peer: Peer | undefined;
  let whep: WhepSession;
  try {
    peer = await deps.openPeer(req.ports);
    whep = await deps.startWhep(peer.offer);
    await peer.accept(whep.answer);
  } catch (err) {
    ffmpeg.kill();
    peer?.close();
    await quietly(deps.log, 'workdir', () => deps.workdir.remove(dir));
    deps.log({ level: 'warn', msg: 'live_start_refused', sessionId, status: err instanceof RingApiError ? err.status : undefined });
    throw new LiveStartError(refusalFor(err));
  }
  const openPeer = peer;

  const endsAt = deps.now() + req.maxMs;
  let end: BridgeEnd | undefined;
  const finish = (why: BridgeEnd) => {
    end ??= why;
  };
  void openPeer.ended.then(() => finish('ring_ended'));
  void ffmpeg.exited.then(() => finish('ffmpeg_exited'));

  const uploaded = new Set<string>();
  let lastPlaylist = '';

  async function publishNew(): Promise<void> {
    const raw = await deps.workdir.read(dir, PLAYLIST);
    if (!raw) return;
    const text = new TextDecoder().decode(raw);

    for (const segment of segmentsToUpload(text, uploaded)) {
      const bytes = await deps.workdir.read(dir, segment);
      if (!bytes) return;
      try {
        await deps.publish.put(`${prefix}${segment}`, bytes, 'video/mp2t', 'public, max-age=60');
        uploaded.add(segment);
      } catch (err) {
        // Never publish a playlist naming a segment that isn't there; retry next tick.
        deps.log({ level: 'warn', msg: 'live_segment_upload_failed', sessionId, err: err instanceof Error ? err.name : 'unknown' });
        return;
      }
    }

    if (text !== lastPlaylist) {
      await deps.publish.put(`${prefix}${PLAYLIST}`, raw, 'application/vnd.apple.mpegurl', 'no-cache, no-store');
      lastPlaylist = text;
    }
  }

  const done = (async (): Promise<BridgeEnd> => {
    try {
      while (end === undefined) {
        if (deps.now() >= endsAt) {
          finish('limit');
          break;
        }
        try {
          await publishNew();
        } catch (err) {
          deps.log({ level: 'warn', msg: 'live_publish_failed', sessionId, err: err instanceof Error ? err.name : 'unknown' });
        }
        await deps.sleep(req.pollMs);
      }
    } finally {
      ffmpeg.kill();
      openPeer.close();
      await quietly(deps.log, 'whep', () => deps.stopWhep(whep.sessionUrl));
      await quietly(deps.log, 'published', () => deps.publish.removePrefix(prefix));
      await quietly(deps.log, 'workdir', () => deps.workdir.remove(dir));
    }
    deps.log({ level: 'info', msg: 'live_ended', sessionId, end, segments: uploaded.size });
    return end ?? 'limit';
  })();

  return { sessionId, endsAt, stop: () => finish('stopped'), done };
}

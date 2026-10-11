/**
 * The live bridge Lambda — M2's media path (arm64 container image with
 * ffmpeg: services/agent/bridge.Dockerfile).
 *
 *   AgentCore live graph ─(async invoke: BridgeJob)─▶ (this)
 *     Ring WHEP ─WebRTC/UDP─▶ werift ─RTP─▶ ffmpeg ─HLS─▶ S3 live/<session>/ ─▶ CloudFront ─▶ TV
 *
 * Here and not in the AgentCore runtime because a Lambda has outbound UDP and
 * the AgentCore microVM doesn't (FRICTION.md FL-017). Wiring only: the
 * sequencing is bridge.ts and bridgeJob.ts, both tested.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { ringClientsByHousehold, startWhepSession, stopWhepSession } from '@wick/ring';
import { startBridge } from './bridge.js';
import { runBridgeJob } from './bridgeJob.js';
import { localWorkdir, s3Publisher, spawnProcess, type S3Send } from './io.js';
import { openWhepPeer } from './peer.js';
import { liveSessions, type LiveDdbSend } from './sessions.js';
import type { BridgeJob } from './startLive.js';

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
/** One Ring client per household. The job names the household whose camera this is. */
const ringFor = ringClientsByHousehold();
const live = liveSessions((cmd) => ddb.send(cmd as never) as ReturnType<LiveDdbSend>, process.env.TABLE_NAME ?? '');
const publish = s3Publisher((cmd) => s3.send(cmd as never) as ReturnType<S3Send>, process.env.MEDIA_BUCKET ?? '');
const workdir = localWorkdir(process.env.LIVE_WORKDIR ?? '/tmp/wick-live');
const ffmpeg = spawnProcess(process.env.FFMPEG_PATH ?? '/opt/ffmpeg', log);
/** One stream per invocation, so fixed local RTP ports are enough. */
const RTP_PORTS = { videoPort: 5004, audioPort: 5006 } as const;

export const handler = async (job: BridgeJob): Promise<{ result: string }> => {
  log({ level: 'info', msg: 'live_bridge_start', sessionId: job.sessionId });
  // The stream is opened with the credential of the household that asked to
  // watch — the one whose television pressed Watch live — and no other's.
  const ring = ringFor(job.householdId);
  const result = await runBridgeJob(job, {
    start: (sessionId, ringDeviceId, maxMs) =>
      startBridge({ sessionId, maxMs, pollMs: 250, ports: RTP_PORTS }, {
        openPeer: (ports) => openWhepPeer(ports, { log }),
        startWhep: (offer) => startWhepSession(ring, ringDeviceId, offer),
        stopWhep: (url) => stopWhepSession(ring, url),
        workdir,
        spawnFfmpeg: ffmpeg,
        publish,
        now: Date.now,
        sleep,
        log,
      }),
    isStopRequested: live.isStopRequested,
    release: live.release,
    now: Date.now,
    sleep,
    stopPollMs: 2000,
  });
  log({ level: 'info', msg: 'live_bridge_done', sessionId: job.sessionId, result });
  return { result };
};

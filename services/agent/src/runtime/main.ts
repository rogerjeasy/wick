/**
 * The AgentCore Runtime container's entrypoint — composition root for the
 * "wick_agents" runtime (infra/agentcore.tf, services/agent/Dockerfile).
 *
 *   door.describe  Strands graph: vision Agent (Nova Lite) → validate   Phase 2b
 *   door.action    Strands graph: gate → ring → notify (no model)        M1
 *   live.start     Strands graph: gate → start (no model)                M2
 *   live.stop      the resident pressed Back                             M2
 *
 * One microVM per household session (invoke.ts), so a live bridge started
 * here keeps streaming in this process after live.start has answered;
 * /ping reports HealthyBusy until it ends so AgentCore keeps the session.
 *
 * Wiring only — every piece it wires is tested on its own. Credentials come
 * from the runtime's execution role and Secrets Manager (AGENTS.md: the
 * Ring token is read at runtime, never baked into the image).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { S3Client } from '@aws-sdk/client-s3';
import { LIVE_MAX_MS } from '@wick/contracts';
import { RingClient, listDevices, ringChime, secretsManagerTokenProvider, startWhepSession, stopWhepSession } from '@wick/ring';
import { sendPatchToDevice } from '../egress.js';
import { describeModel } from '../graphs/doorDescribe.js';
import { startBridge, type BridgeDeps } from '../live/bridge.js';
import { playlistUrlFor } from '../live/hls.js';
import { localWorkdir, s3Publisher, spawnProcess, type S3Send } from '../live/io.js';
import { openWhepPeer } from '../live/peer.js';
import { LiveRegistry } from '../live/registry.js';
import { cardStore, type DdbSend } from '../store/cards.js';
import { doorActionHandler, doorDescribeHandler, liveStartHandler, liveStopHandler } from './handlers.js';
import { createRuntimeServer } from './server.js';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} not set`);
  return value;
};

const TABLE = env('TABLE_NAME');
const MEDIA_BUCKET = env('MEDIA_BUCKET');
const LIVE_ORIGIN = env('LIVE_ORIGIN');
const CHIME_SLOT = env('WICK_CHIME_SLOT_EVENT', 'ring-appstore-event-1');
const FFMPEG = env('FFMPEG_PATH', 'ffmpeg');
const LIVE_WORKDIR = env('LIVE_WORKDIR', '/tmp/wick-live');
const PORT = Number(env('PORT', '8080'));
/** One household per microVM, so one bridge at a time: fixed local RTP ports are enough. */
const RTP_PORTS = { videoPort: 5004, audioPort: 5006 } as const;

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

const ddb = new DynamoDBClient({});
const s3 = new S3Client({});
const ring = new RingClient({ getToken: secretsManagerTokenProvider() });
// The narrow send types in store/ and live/ keep those modules testable; the real clients satisfy them.
const cards = cardStore((cmd) => ddb.send(cmd as never) as ReturnType<DdbSend>, TABLE);
const registry = new LiveRegistry();

const bridgeDeps = (ringDeviceId: string): BridgeDeps => ({
  openPeer: (ports) => openWhepPeer(ports),
  startWhep: (offer) => startWhepSession(ring, ringDeviceId, offer),
  stopWhep: (url) => stopWhepSession(ring, url),
  workdir: localWorkdir(LIVE_WORKDIR),
  spawnFfmpeg: spawnProcess(FFMPEG, log),
  publish: s3Publisher((cmd) => s3.send(cmd as never) as ReturnType<S3Send>, MEDIA_BUCKET),
  now: Date.now,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  log,
});

const server = createRuntimeServer({
  busy: () => registry.busy(),
  log,
  handlers: {
    'door.describe': doorDescribeHandler(describeModel),

    'door.action': doorActionHandler((householdId) => ({
      loadCard: cards.loadCard,
      claimOnce: cards.claimOnce,
      listDevices: () => listDevices(ring),
      ringChime: (chimeId) => ringChime(ring, chimeId, CHIME_SLOT),
      sendPatch: (patch) => sendPatchToDevice(patch, householdId),
      now: Date.now,
    })),

    'live.start': liveStartHandler(() => ({
      loadLiveTarget: cards.loadLiveTarget,
      now: Date.now,
      startLive: (householdId, ringDeviceId) =>
        registry.start(householdId, (sessionId) =>
          startBridge({ sessionId, maxMs: LIVE_MAX_MS, pollMs: 250, ports: RTP_PORTS }, bridgeDeps(ringDeviceId))),
      playlistUrl: (sessionId) => playlistUrlFor(LIVE_ORIGIN, sessionId),
    })),

    'live.stop': liveStopHandler(registry),
  },
});

server.listen(PORT, '0.0.0.0', () => log({ level: 'info', msg: 'wick_agents_listening', port: PORT }));

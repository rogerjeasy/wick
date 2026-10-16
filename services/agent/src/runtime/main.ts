/**
 * The AgentCore Runtime container's entrypoint — composition root for the
 * "wick_agents" runtime (infra/agentcore.tf, services/agent/Dockerfile).
 *
 *   door.describe  Strands graph: vision Agent (Nova Lite) → validate   Phase 2b
 *   door.action    Strands graph: gate → ring → notify (no model)        M1
 *   live.start     Strands graph: gate → start (no model)                M2
 *   live.stop      the resident pressed Back                             M2
 *   assistant.turn Strands Agent (Sonnet 4.5 + Guardrail) on Wick's MCP     §6
 *                  tools, with the member's own token; writes wait for
 *                  their yes (agents/assistant/)
 *   brief.weekly   Strands graph: analyst → writer → check → suggester   the Sunday brief
 *
 * One microVM per household session (invoke.ts). The live stream itself
 * runs in the bridge Lambda, not here: this microVM has no outbound UDP and
 * WebRTC needs it (FRICTION.md FL-017). The graph decides; the Lambda streams.
 *
 * Wiring only — every piece it wires is tested on its own. Credentials come
 * from the runtime's execution role and Secrets Manager (AGENTS.md: the
 * Ring token is read at runtime, never baked into the image).
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { listDevices, ringChime, ringClientsByHousehold } from '@wick/ring';
import { sendPatchToDevice } from '../egress.js';
import { describeModel } from '../graphs/doorDescribe.js';
import { randomBytes } from 'node:crypto';
import { playlistUrlFor } from '../live/hls.js';
import { liveSessions, type LiveDdbSend } from '../live/sessions.js';
import { startLive } from '../live/startLive.js';
import { cardStore, type DdbSend } from '../store/cards.js';
import { devicesOfHousehold, ringDeviceOwners } from '../store/ringDevices.js';
import { doorActionHandler, doorDescribeHandler, liveStartHandler, liveStopHandler } from './handlers.js';
import { assistantTurnHandler } from '../agents/assistant/turn.js';
import { assistantDepsFromEnv } from '../agents/assistant/fromEnv.js';
import { agentCoreSessions } from '../agents/assistant/sessions.js';
import { createRuntimeServer } from './server.js';
import { BRIEF_WEEKLY_KIND, briefWeeklyHandler } from './briefHandler.js';
import { briefWeeklyDepsFor } from './briefWiring.js';

const env = (name: string, fallback?: string): string => {
  const value = process.env[name] ?? fallback;
  if (value === undefined || value === '') throw new Error(`${name} not set`);
  return value;
};

const TABLE = env('TABLE_NAME');
const LIVE_BRIDGE_FUNCTION = env('LIVE_BRIDGE_FUNCTION');
const LIVE_ORIGIN = env('LIVE_ORIGIN');
const CHIME_SLOT = env('WICK_CHIME_SLOT_EVENT', 'ring-appstore-event-1');
const PORT = Number(env('PORT', '8080'));

const log = (line: Record<string, unknown>) => console.log(JSON.stringify(line));

const ddb = new DynamoDBClient({});
const lambda = new LambdaClient({});
/** One Ring client per household, each carrying that household's own token: there is no client without one. */
const ringFor = ringClientsByHousehold();
// The narrow send types in store/ and live/ keep those modules testable; the real clients satisfy them.
const cards = cardStore((cmd) => ddb.send(cmd as never) as ReturnType<DdbSend>, TABLE);
const ringDevices = ringDeviceOwners((cmd) => ddb.send(cmd as never) as ReturnType<DdbSend>, TABLE);
const live = liveSessions((cmd) => ddb.send(cmd as never) as ReturnType<LiveDdbSend>, TABLE);

/** Made at the first turn, and kept: one model client and one memory client for the life of the microVM. */
let assistantDeps: ReturnType<typeof assistantDepsFromEnv>;

const server = createRuntimeServer({
  busy: () => false,
  log,
  handlers: {
    'door.describe': doorDescribeHandler(describeModel),

    'door.action': doorActionHandler((householdId) => ({
      loadCard: cards.loadCard,
      claimOnce: cards.claimOnce,
      // This household's own Ring link, and of what it can see only the
      // chimes this household holds: a press here must never make a sound
      // in another home.
      listDevices: async () => devicesOfHousehold(householdId, await listDevices(ringFor(householdId)), ringDevices.householdOf),
      ringChime: (chimeId) => ringChime(ringFor(householdId), chimeId, CHIME_SLOT),
      sendPatch: (patch) => sendPatchToDevice(patch, householdId),
      now: Date.now,
    })),

    'live.start': liveStartHandler(() => ({
      loadLiveTarget: cards.loadLiveTarget,
      now: Date.now,
      startLive: (householdId, ringDeviceId) =>
        startLive(householdId, ringDeviceId, {
          claim: live.claim,
          release: live.release,
          // Event: the TV gets its playlist URL now; the stream follows in the Lambda.
          invokeBridge: async (job) => {
            await lambda.send(new InvokeCommand({
              FunctionName: LIVE_BRIDGE_FUNCTION,
              InvocationType: 'Event',
              Payload: new TextEncoder().encode(JSON.stringify(job)),
            }));
          },
          newSessionId: () => randomBytes(16).toString('base64url'),
          now: Date.now,
        }),
      playlistUrl: (sessionId) => playlistUrlFor(LIVE_ORIGIN, sessionId),
    })),

    'live.stop': liveStopHandler(live.requestStop),

    // The family assistant (agents/assistant/). Its settings are read per turn, so a
    // runtime without them still serves the door; the turn then says it is not set up.
    // Conversations are kept in AgentCore Memory (packages/strands-agentcore-session), so one
    // survives a cold start of this microVM; in this process only where no memory is configured.
    'assistant.turn': assistantTurnHandler(() => (assistantDeps ??= assistantDepsFromEnv(process.env, agentCoreSessions(process.env.AWS_REGION ? { region: process.env.AWS_REGION } : {})))),
    [BRIEF_WEEKLY_KIND]: briefWeeklyHandler(briefWeeklyDepsFor(ddb, TABLE)),
  },
});

server.listen(PORT, '0.0.0.0', () => log({ level: 'info', msg: 'wick_agents_listening', port: PORT }));

/**
 * Prints the start time (epoch ms) of a Ring device's most recent real
 * history event — what `RING_TEST_OCCURRED_AT=latest` in
 * test-ring-webhook.sh stamps onto its signed payload.
 *
 *   npx vite-node -c vitest.config.ts scripts/latest-ring-event.ts <deviceId>
 *
 * Why it exists: Phase 2 fetches the frame Ring *recorded* at the event's
 * time (FRICTION.md FL-005). A webhook stamped "now" with nothing behind it
 * gets `416 MEDIA_NOT_FOUND`, so the card never gets its picture or
 * description. Pointing the payload at a real event — press a simulation
 * button in the Ring Developer Playground first for a fresh one — exercises
 * Phase 2 against real media, while webhook delivery itself stays synthetic
 * (FL-010).
 */
import { loadEnv, ringToken } from './env.js';
import { RingClient, latestEvent } from '@wick/ring';

const deviceId = process.argv[2];
if (!deviceId) {
  console.error('usage: latest-ring-event.ts <deviceId>');
  process.exit(2);
}

loadEnv();
const event = await latestEvent(new RingClient({ getToken: ringToken }), deviceId);
if (!event) {
  console.error(`no history events for ${deviceId} — trigger one in the Ring Developer Playground first`);
  process.exit(1);
}
console.error(`latest event: ${event.eventType} at ${new Date(event.start).toISOString()}`);
console.log(event.start);

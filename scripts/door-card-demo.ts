/**
 * The Door Card, end to end, against the live Ring API.
 *
 *   npm run demo:door
 *
 * Every number this prints is measured, and every field comes from Ring. There
 * is no fixture here — if the token is dead or the device is gone, this script
 * fails rather than inventing something to show. That is the point: it is the
 * rehearsal for the demo video, so it has to break the same way the product
 * would.
 *
 * Phase 1 is local and instant. Phase 2a is one Ring round trip. Phase 2b is
 * Bedrock, and if it declines or is not enabled, Phase 1 stands — which is the
 * designed behaviour, not a fallback bolted on for the script.
 */
import { writeFileSync } from 'node:fs';
import { loadEnv, ringToken } from './env.js';
import {
  RingClient,
  listDevices,
  latestEvent,
  imageAt,
  fetchImageBytes,
  selectorForEvent,
  type RingDevice,
} from '@wick/ring';
import {
  buildPhaseOneCard,
  buildImagePatch,
  buildDescriptionPatch,
} from '../services/agent/src/agents/door/index.js';
import { describeFrame } from '../services/agent/src/agents/door/describe.js';

const OUT_IMAGE = process.env.WICK_DEMO_IMAGE ?? '/tmp/wick-door-frame.jpg';

const ms = (n: number) => `${n.toFixed(0)}ms`;
const rule = (s: string) => console.log(`\n\x1b[2m── ${s} ${'─'.repeat(Math.max(0, 58 - s.length))}\x1b[0m`);

async function timed<T>(fn: () => Promise<T>): Promise<[T, number]> {
  const t = performance.now();
  return [await fn(), performance.now() - t];
}

async function main() {
  // Before any AWS client exists: .env is applied and the credential source is
  // named, so a failure says where it looked rather than "any providers".
  const aws = loadEnv();
  console.log(`aws: ${aws.detail}`);
  if (aws.source === 'none') {
    console.log('     the vision step will be skipped — Phase 1 still works');
  }

  const client = new RingClient({ getToken: ringToken });
  const correlationId = `demo-${process.pid}-${Date.now().toString(36)}`;

  rule('devices');
  const [devices, tDevices] = await timed(() => listDevices(client));
  for (const d of devices) {
    console.log(
      `   ${d.online ? '●' : '○'} ${d.name || '(unnamed)'}  ` +
        `motion=${d.capabilities.motion} image=${d.capabilities.image} ` +
        `chime=${d.capabilities.chime}${d.capabilities.maxResolution ? ` ${d.capabilities.maxResolution}p` : ''}`,
    );
  }
  console.log(`   ${devices.length} device(s) in ${ms(tDevices)}`);

  const device: RingDevice | undefined = devices.find((d) => d.capabilities.image) ?? devices[0];
  if (!device) throw new Error('No Ring devices on this account — nothing to build a card from.');

  rule('most recent door event');
  const [event, tEvent] = await timed(() => latestEvent(client, device.id));
  if (!event) throw new Error(`No history events on ${device.name}. Trigger one, then re-run.`);
  console.log(`   ${event.eventType}  at ${new Date(event.start).toISOString()}  (${ms(tEvent)})`);
  if (event.detections.length) console.log(`   detections: ${event.detections.join(', ')}`);

  rule('PHASE 1 — what the television shows immediately');
  const [card, tCard] = await timed(async () =>
    buildPhaseOneCard({
      event,
      device,
      householdId: 'demo-household',
      correlationId,
      now: Date.now(),
    }),
  );
  console.log(`   ${ms(tCard)}  (local — no network, no model)\n`);
  console.log(`      ┌${'─'.repeat(52)}┐`);
  console.log(`      │  ${card.line.padEnd(50)}│`);
  console.log(`      │  ${'(no picture yet)'.padEnd(50)}│`);
  console.log(`      │${' '.repeat(52)}│`);
  console.log(`      │  ${card.actions.map((a) => a.label).join('  ·  ').padEnd(50)}│`);
  console.log(`      └${'─'.repeat(52)}┘`);
  if (!device.capabilities.chime) {
    console.log(`\n   "Just a moment" is absent: ${device.name || 'this device'} reports no Chime Controls.`);
    console.log(`   The button is not drawn rather than drawn and broken.`);
  }

  rule('PHASE 2a — the picture');
  const [image, tUrl] = await timed(() => imageAt(client, device.id, selectorForEvent(event)));
  console.log(`   presigned URL in ${ms(tUrl)}  (redirect not followed)`);
  console.log(`   host ${new URL(image.url).host}`);

  // Validated at the source: the media host answers some failures with a JSON
  // error body that would otherwise land on disk as a .jpg.
  const [bytes, tBytes] = await timed(() => fetchImageBytes(image, client.fetchImpl));
  writeFileSync(OUT_IMAGE, bytes);
  console.log(`   ${(bytes.length / 1024).toFixed(0)}KB downloaded in ${ms(tBytes)} -> ${OUT_IMAGE}`);
  console.log(`   total ${ms(tUrl + tBytes)} — which is why this is a patch, not Phase 1`);
  console.log(`   patch: ${JSON.stringify(buildImagePatch(card.id, image))}`);

  rule('PHASE 2b — the sentence');
  const described = await describeFrame(bytes);
  if (described.candidate) {
    const patch = buildDescriptionPatch(card.id, described.candidate);
    console.log(`   ${ms(described.elapsedMs)}  "${described.candidate.description}"`);
    console.log(`   patch: ${JSON.stringify(patch)}`);
  } else {
    console.log(`   ${ms(described.elapsedMs)}  no description: ${described.reason}`);
    console.log(`   Phase 1 stands. The card is still useful. (Principle 11)`);
  }

  rule('the card as the device would receive it');
  console.log(JSON.stringify(card, null, 2).split('\n').map((l) => `   ${l}`).join('\n'));
}

main().catch((err) => {
  console.error(`\n\x1b[31m✗ ${err instanceof Error ? err.message : String(err)}\x1b[0m`);
  process.exit(1);
});

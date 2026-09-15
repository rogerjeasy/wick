/**
 * Watch for a new Ring event, grab its frame, and describe it.
 *
 *   npm run demo:capture           # take the newest event as it stands
 *   npm run demo:capture -- --watch  # wait for one that isn't there yet
 *
 * This is the tool for the demo shot. Trigger an event in the Ring Developer
 * Playground (live-view event simulation: Package, Vehicle or Motion) and this
 * catches the resulting history entry, pulls the still, and runs the real
 * vision step over it — so you can see what the card would actually say before
 * committing it to a video.
 *
 * No WebRTC involved. The Playground's simulation is a live-view feature, but
 * the events it raises land in device history, and history is what the image
 * endpoint indexes. If that assumption ever breaks, this prints that it saw no
 * new event rather than quietly showing you a stale frame.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { RingClient, listDevices, listEvents, imageForEvent } from '@wick/ring';
import type { RingHistoryEvent } from '@wick/ring';
import { describeFrame } from '../services/agent/src/agents/door/describe.js';

const WATCH = process.argv.includes('--watch');
/** --file <path>: describe a frame already captured, no Ring call at all. */
const FILE = (() => {
  const i = process.argv.indexOf('--file');
  return i >= 0 ? process.argv[i + 1] : undefined;
})();
const POLL_MS = 3000;
const WATCH_TIMEOUT_MS = 5 * 60 * 1000;

function token(): string {
  if (process.env.RING_OAUTH_TOKEN) return process.env.RING_OAUTH_TOKEN;
  const line = readFileSync(new URL('../.env', import.meta.url), 'utf8')
    .split('\n')
    .find((l) => /^\s*RING_OAUTH_TOKEN\s*=/.test(l));
  if (!line) throw new Error('No RING_OAUTH_TOKEN in the environment or .env');
  return line.split('=').slice(1).join('=').trim().replace(/^["']|["']$/g, '');
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const stamp = (e: RingHistoryEvent) => `${e.eventType} at ${new Date(e.start).toISOString()}`;

async function main() {
  if (FILE) {
    const bytes = new Uint8Array(readFileSync(FILE));
    console.log(`describing ${FILE} (${(bytes.length / 1024).toFixed(0)}KB)`);
    const only = await describeFrame(bytes);
    console.log(
      only.candidate
        ? `\nthe card would say:\n   "${only.candidate.description}"  (${only.elapsedMs}ms)`
        : `\nno description: ${only.reason}`,
    );
    return;
  }

  const client = new RingClient({ getToken: token });

  const devices = await listDevices(client);
  const device = devices.find((d) => d.capabilities.image) ?? devices[0];
  if (!device) throw new Error('No Ring devices on this account.');
  console.log(`device: ${device.name || device.id}`);

  const before = await listEvents(client, device.id);
  console.log(`${before.length} event(s) already on record:`);
  for (const e of before) console.log(`   ${stamp(e)}`);

  let target = before[0];

  if (WATCH) {
    const known = new Set(before.map((e) => e.id));
    console.log(`\nwatching for a NEW event — trigger one in the Playground now.`);
    console.log(`(polling every ${POLL_MS / 1000}s, giving up after ${WATCH_TIMEOUT_MS / 60000} min)\n`);

    const deadline = Date.now() + WATCH_TIMEOUT_MS;
    let found: RingHistoryEvent | undefined;

    while (Date.now() < deadline && !found) {
      await sleep(POLL_MS);
      const now = await listEvents(client, device.id);
      found = now.find((e) => !known.has(e.id));
      process.stdout.write(found ? '\n' : '.');
    }

    if (!found) {
      // Say so plainly. A stale frame presented as a new one is the one outcome
      // that would actually mislead.
      console.log(`\n\nNo new event arrived. Nothing captured — the frame below would`);
      console.log(`have been the old one, so this is stopping instead.`);
      process.exit(2);
    }

    console.log(`new event: ${stamp(found)}`);
    target = found;
  }

  if (!target) throw new Error('No events at all on this device.');

  // Retried: the media host fails most first attempts straight after an event
  // with GRECO_NO_VALID_KEY, then settles. See FL-008.
  const { bytes, attempts } = await imageForEvent(client, device.id, target);
  const out = `/tmp/ring-${target.eventType}-${target.start}.jpg`;
  writeFileSync(out, bytes);
  console.log(
    `\nframe: ${(bytes.length / 1024).toFixed(0)}KB -> ${out}` +
      (attempts > 1 ? `  (after ${attempts} attempts — key propagation, FL-008)` : ''),
  );

  const described = await describeFrame(bytes);
  console.log(
    described.candidate
      ? `\nthe card would say:\n   "${described.candidate.description}"  (${described.elapsedMs}ms)`
      : `\nno description: ${described.reason}\n   Phase 1 stands.`,
  );
}

main().catch((err) => {
  console.error(`\n✗ ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});

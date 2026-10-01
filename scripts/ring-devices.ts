/**
 * Lists every device on the linked Ring account with the raw capabilities,
 * status and configurations Ring reports for it — the three documents that
 * decide whether a card can offer "Ring the hallway chime" (a chime with `chime.play`
 * and a slot holding audio) and "Watch live" (a camera with video codecs).
 *
 *   npx vite-node -c vitest.config.ts scripts/ring-devices.ts
 *
 * Prints JSON. Never prints the token.
 */
import { loadEnv, ringToken } from './env.js';
import { RingClient } from '@wick/ring';

loadEnv();
const client = new RingClient({ getToken: ringToken });

const list = (await client.get('/v1/devices')) as { data: { id: string; attributes: { name: string } }[] };

const out = [];
for (const d of list.data) {
  const read = async (rel: string): Promise<unknown> => {
    try {
      return ((await client.get(`/v1/devices/${d.id}/${rel}`)) as { data: { attributes: unknown } }).data.attributes;
    } catch (err) {
      return { error: err instanceof Error ? err.message : String(err) };
    }
  };
  out.push({
    id: d.id,
    name: d.attributes.name,
    capabilities: await read('capabilities'),
    status: await read('status'),
    configurations: await read('configurations'),
  });
}

console.log(JSON.stringify(out, null, 2));

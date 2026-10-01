# M1 Hallway Chime Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pressing "Ring the hallway chime" on a Door Card sounds every playable Ring Chime in the household and tells the resident, on the same card, what happened.

**Architecture:** Discovery happens in Phase 1 from the device list the Door Lambda already caches (no new Ring call). The press travels TV → WebSocket `route.mjs` → EventBridge (`wick.device` / `card.action`) → a new `agent-card-action` Lambda, which checks the card is live, claims the ring exactly once, plays the chime's slot audio through Ring's documented JSON:API playback call, and patches the card with a plain sentence and without the chime button. No model is involved at any point (spec D4).

**Tech Stack:** TypeScript (NodeNext ESM), vitest, Ring Partner API (Chimes, Early Access), AWS Lambda nodejs22.x arm64, EventBridge, DynamoDB, Terraform (aws ~> 6.0), Vega React Native 0.83.

**Spec:** `docs/superpowers/specs/2026-10-01-agent-graph-and-door-actions-design.md` §2 D1/D2/D4, §4.2, §5, §6.

## Global Constraints

- Action id `hallway_chime`, label `Ring the hallway chime`, kind `secondary`. Door actions in order: `watch_live`, `hallway_chime`, `dismiss`. Never more than `MAX_CARD_ACTIONS` (3).
- A chime is a device whose `capabilities.audio.supported_actions` contains `chime.play`. Never infer from name or `image_url`.
- Never play when `status.online !== true` or `status.audio.snooze.active === true`.
- Playback body is exactly `{ "data": { "type": "audio", "attributes": { "audio_ref": "<audio_ref>" } } }`; success is `200` with `data.attributes.status === "completed"`.
- Slot to play: env `WICK_CHIME_SLOT_EVENT`, default `ring-appstore-event-1`; fall back to the first enabled slot (slots sorted by `event`).
- At most one ring per card, ever (conditional write `CHIME#<cardId>`). Never ring for a card past `expiresAt`. Never retry a playback call.
- Feedback copy, verbatim: rang → `The hallway chime rang.`; snoozed → `The hallway chime is snoozed, so it stayed quiet.`; offline/failed → `The hallway chime didn't answer.`; no_audio → `The hallway chime has no sound set up for Wick.`; no chime → `There's no hallway chime Wick can reach.`
- Egress stays in `services/agent/src/egress.ts` (INV-2). Logs never contain tokens or card content beyond ids.
- Never add a `Co-Authored-By` trailer to commits.

## Review Focus

- **Chime snoozed between Phase 1 and the press** — the card offered the button, the resident pressed it, the household snoozed the chime in between: must not ring; must say it's snoozed. (Test in Task 1 `ringChime` + Task 5.)
- **Double press / EventBridge redelivery** — two `card.action` events for the same card must produce exactly one playback call. (Task 5 `claimOnce` test.)
- **Press on a card that has aged out** (5-minute TTL passed while the card sat on screen) — no ring, no patch. (Task 5 stale test.)
- **Household with two chimes, one offline** — rings the online one and reports `rang`. (Task 1 `summariseChimeOutcomes` test.)
- **Ring answers 200 but `status` is not `completed`** — must report `failed`, not `rang`. (Task 1 test.)

---

### Task 1: Ring connector — chimes are devices that say `chime.play`

**Files:**
- Modify: `services/connectors/ring/src/types.ts`
- Modify: `services/connectors/ring/src/jsonapi.ts`
- Create: `services/connectors/ring/src/chime.ts`
- Modify: `services/connectors/ring/src/index.ts`
- Modify: `services/connectors/ring/src/deviceCache.ts`
- Test: `services/connectors/ring/src/__tests__/jsonapi.test.ts`, `services/connectors/ring/src/__tests__/chime.test.ts` (new), `services/connectors/ring/src/__tests__/deviceCache.test.ts`

**Interfaces:**
- Produces:
  - `RingCapabilities.chime: boolean` — now "this device is a playable chime (`chime.play`)".
  - `RingDevice.snoozed?: boolean`
  - `interface ChimeSlot { event: string; disabled: boolean; audioRef: string; audioName: string }`
  - `type ChimeOutcome = 'rang' | 'snoozed' | 'offline' | 'no_audio' | 'failed'`
  - `parseChimeSlots(doc: unknown): ChimeSlot[]`, `parsePlaybackStatus(doc: unknown): string | null`
  - `playableChimes(devices: readonly RingDevice[]): RingDevice[]`
  - `hasHallwayChime(devices: readonly RingDevice[]): boolean`
  - `ringChime(client: RingClient, chimeId: string, slotEvent: string): Promise<ChimeOutcome>`
  - `summariseChimeOutcomes(outcomes: readonly ChimeOutcome[]): ChimeOutcome | 'no_chime'`
  - `cachedDevices(options: CachedDeviceLookupOptions): { find(id: string): Promise<RingDevice | undefined>; all(): Promise<readonly RingDevice[]> }`

- [ ] **Step 1: Update the jsonapi tests to the documented chime shape (failing)**

In `services/connectors/ring/src/__tests__/jsonapi.test.ts`, replace the test `'reports a chime when the device actually lists audio actions'` with:

```ts
  it('reports a chime only when supported_actions contains chime.play — Ring docs, Chimes', () => {
    const withChime = structuredClone(DEVICE_RESPONSE);
    (withChime.included[1]!.attributes as Record<string, unknown>).audio = {
      supported_actions: ['chime.play'],
      customizable_slots: 2,
    };
    const parsed = unwrap(withChime);
    expect(parseDevice(parsed.items[0]!, parsed.included).capabilities.chime).toBe(true);
  });

  it('does not treat some other audio action as a chime — the button would 400', () => {
    const other = structuredClone(DEVICE_RESPONSE);
    (other.included[1]!.attributes as Record<string, unknown>).audio = {
      supported_actions: ['play_sound'],
      customizable_slots: null,
    };
    const parsed = unwrap(other);
    expect(parseDevice(parsed.items[0]!, parsed.included).capabilities.chime).toBe(false);
  });

  it('reads snooze from status.audio.snooze.active, and only a literal true counts', () => {
    const snoozed = structuredClone(DEVICE_RESPONSE);
    (snoozed.included[0]!.attributes as Record<string, unknown>).audio = {
      snooze: { active: true, until: '2026-10-01T10:00:00Z' },
    };
    const a = unwrap(snoozed);
    expect(parseDevice(a.items[0]!, a.included).snoozed).toBe(true);
    // The live Playground camera reports snooze.active: null.
    expect(device.snoozed).toBeUndefined();
  });
```

Append a new describe block:

```ts
describe('parseChimeSlots', () => {
  // Shape verbatim from Ring's Chimes doc (verified there against a Chime Pro).
  const CONFIG = {
    data: {
      type: 'device-configurations',
      id: 'cfg',
      attributes: {
        motion_detection: { enabled: null },
        audio: {
          customizable_slots: [
            { event: 'ring-appstore-event-2', disabled: false, audio_ref: 'ref-2', audio_url: 'https://h/2.wav', audio_name: 'Ring Alert 3' },
            { event: 'ring-appstore-event-1', disabled: false, audio_ref: 'ref-1', audio_url: 'https://h/1.wav', audio_name: 'Navi' },
          ],
          volume: 4,
        },
      },
    },
  };

  it('returns the slots sorted by event, because Ring does not', () => {
    expect(parseChimeSlots(CONFIG).map((s) => s.event)).toEqual(['ring-appstore-event-1', 'ring-appstore-event-2']);
    expect(parseChimeSlots(CONFIG)[0]).toEqual({ event: 'ring-appstore-event-1', disabled: false, audioRef: 'ref-1', audioName: 'Navi' });
  });

  it('returns nothing for a camera, whose customizable_slots is null', () => {
    expect(parseChimeSlots({ data: { attributes: { audio: { customizable_slots: null, volume: 11 } } } })).toEqual([]);
  });

  it('drops a slot with no audio_ref rather than playing nothing', () => {
    const broken = structuredClone(CONFIG);
    (broken.data.attributes.audio.customizable_slots[0] as Record<string, unknown>).audio_ref = null;
    expect(parseChimeSlots(broken).map((s) => s.audioRef)).toEqual(['ref-1']);
  });
});

describe('parsePlaybackStatus', () => {
  it('reads data.attributes.status', () => {
    expect(parsePlaybackStatus({ data: { type: 'audio', id: 'ref-1', attributes: { status: 'completed' } } })).toBe('completed');
  });
  it('is null when the shape is anything else', () => {
    expect(parsePlaybackStatus({})).toBeNull();
  });
});
```

and change the import to `import { unwrap, parseDevice, parseHistoryEvent, parseChimeSlots, parsePlaybackStatus } from '../jsonapi.js';`

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run services/connectors/ring/src/__tests__/jsonapi.test.ts`
Expected: FAIL — `parseChimeSlots is not a function`, and the `play_sound` test fails because `chime` is true.

- [ ] **Step 3: Implement types and parsing**

`services/connectors/ring/src/types.ts` — replace the `chime` doc comment and add fields/types:

```ts
  /**
   * This device IS a chime Wick can sound: `audio.supported_actions` contains
   * `chime.play` (Ring docs, Chimes → Identifying a Chime). A camera's audio
   * block is present-but-null (FL-006); a chime is a separate device.
   */
  readonly chime: boolean;
```

In `RingDevice` add after `reportedAt`:

```ts
  /** `status.audio.snooze.active`. Only a chime reports it; a snoozed chime must not be played. */
  readonly snoozed?: boolean;
```

Append:

```ts
/** One of the app's audio slots on a chime (`configurations.audio.customizable_slots[]`). */
export interface ChimeSlot {
  readonly event: string;
  readonly disabled: boolean;
  readonly audioRef: string;
  readonly audioName: string;
}

/** What happened when Wick asked one chime to play. */
export type ChimeOutcome = 'rang' | 'snoozed' | 'offline' | 'no_audio' | 'failed';
```

`services/connectors/ring/src/jsonapi.ts` — in `parseCapabilities` replace the chime line and comment:

```ts
    // Ring docs, Chimes: "A chime is the device whose audio.supported_actions
    // includes chime.play". A present-but-null block is the Playground camera
    // (FL-006); some other action name is not something we know how to play.
    chime: Array.isArray(actions) && actions.includes('chime.play'),
```

In `parseDevice`, after `reportedAt` is computed:

```ts
  const audio = isRecord(status.audio) ? status.audio : {};
  const snooze = isRecord(audio.snooze) ? audio.snooze : {};
```

and in the returned object after the `reportedAt` spread:

```ts
    ...(snooze.active === true ? { snoozed: true } : {}),
```

Append to the file (and extend the type import to include `ChimeSlot`):

```ts
/** `GET /v1/devices/{id}/configurations` → the chime's slots, sorted by event (Ring does not sort). */
export function parseChimeSlots(doc: unknown): ChimeSlot[] {
  const data = isRecord(doc) && isRecord(doc.data) ? doc.data : {};
  const attrs = isRecord(data.attributes) ? data.attributes : {};
  const audio = isRecord(attrs.audio) ? attrs.audio : {};
  const slots = Array.isArray(audio.customizable_slots) ? audio.customizable_slots : [];

  return slots
    .filter(isRecord)
    .filter((s) => typeof s.event === 'string' && typeof s.audio_ref === 'string' && s.audio_ref !== '')
    .map((s) => ({
      event: s.event as string,
      disabled: s.disabled === true,
      audioRef: s.audio_ref as string,
      audioName: typeof s.audio_name === 'string' ? s.audio_name : '',
    }))
    .sort((a, b) => a.event.localeCompare(b.event));
}

/** `POST …/media/audio/playback` → `data.attributes.status` ("completed" means it played). */
export function parsePlaybackStatus(doc: unknown): string | null {
  const data = isRecord(doc) && isRecord(doc.data) ? doc.data : {};
  const attrs = isRecord(data.attributes) ? data.attributes : {};
  return typeof attrs.status === 'string' ? attrs.status : null;
}
```

- [ ] **Step 4: Run jsonapi tests to verify they pass**

Run: `npx vitest run services/connectors/ring/src/__tests__/jsonapi.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing chime tests**

Create `services/connectors/ring/src/__tests__/chime.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { RingClient } from '../client.js';
import { hasHallwayChime, playableChimes, ringChime, summariseChimeOutcomes } from '../chime.js';
import type { RingDevice } from '../types.js';

type Reply = { status?: number; json?: unknown };

/** Routes by path suffix; records every call. */
function ring(routes: Record<string, Reply | Reply[]>) {
  const calls: { url: string; init: RequestInit }[] = [];
  const counters: Record<string, number> = {};
  const fetchImpl = (async (url: string, init: RequestInit = {}) => {
    calls.push({ url, init });
    const key = Object.keys(routes).find((k) => url.endsWith(k));
    if (!key) throw new Error(`unexpected ${url}`);
    const list = Array.isArray(routes[key]) ? (routes[key] as Reply[]) : [routes[key] as Reply];
    const r = list[Math.min((counters[key] = (counters[key] ?? -1) + 1), list.length - 1)]!;
    const status = r.status ?? 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: () => null },
      json: async () => r.json,
      text: async () => '',
    };
  }) as unknown as typeof fetch;
  return { client: new RingClient({ getToken: () => 'tok', fetchImpl }), calls };
}

const STATUS = (online: boolean, snoozed: boolean) => ({
  json: { data: { type: 'device-status', attributes: { online, audio: { snooze: { active: snoozed, until: null } } } } },
});
const CONFIG = {
  json: {
    data: {
      attributes: {
        audio: {
          customizable_slots: [
            { event: 'ring-appstore-event-2', disabled: false, audio_ref: 'ref-2', audio_name: 'B' },
            { event: 'ring-appstore-event-1', disabled: false, audio_ref: 'ref-1', audio_name: 'A' },
          ],
        },
      },
    },
  },
};
const PLAYED = { json: { data: { type: 'audio', id: 'ref-1', attributes: { status: 'completed' } } } };

const dev = (id: string, over: Partial<RingDevice> & { chime?: boolean } = {}): RingDevice => ({
  id,
  name: id,
  online: over.online ?? true,
  ...(over.snoozed ? { snoozed: true } : {}),
  capabilities: { motion: false, image: false, chime: over.chime ?? true },
});

describe('playableChimes / hasHallwayChime', () => {
  it('keeps only online, unsnoozed chimes', () => {
    const devices = [dev('cam', { chime: false }), dev('c1'), dev('c2', { online: false }), dev('c3', { snoozed: true })];
    expect(playableChimes(devices).map((d) => d.id)).toEqual(['c1']);
    expect(hasHallwayChime(devices)).toBe(true);
  });

  it('is false for the Playground account — one camera, no chime', () => {
    expect(hasHallwayChime([dev('cam', { chime: false })])).toBe(false);
  });
});

describe('ringChime', () => {
  it('re-reads status, takes the configured slot, and posts the documented JSON:API body', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': CONFIG, '/c1/media/audio/playback': PLAYED });

    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('rang');

    const post = r.calls.find((c) => c.url.endsWith('/media/audio/playback'))!;
    expect(post.init.method).toBe('POST');
    expect(JSON.parse(post.init.body as string)).toEqual({ data: { type: 'audio', attributes: { audio_ref: 'ref-1' } } });
  });

  it('never plays a chime that was snoozed after the card went out', async () => {
    const r = ring({ '/c1/status': STATUS(true, true) });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('snoozed');
    expect(r.calls.some((c) => c.url.includes('playback'))).toBe(false);
  });

  it('reports offline without calling playback', async () => {
    const r = ring({ '/c1/status': STATUS(false, false) });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('offline');
  });

  it('falls back to the first enabled slot when the configured one is missing', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': CONFIG, '/c1/media/audio/playback': PLAYED });
    await ringChime(r.client, 'c1', 'ring-appstore-event-9');
    const post = r.calls.find((c) => c.url.endsWith('/media/audio/playback'))!;
    expect(JSON.parse(post.init.body as string).data.attributes.audio_ref).toBe('ref-1');
  });

  it('reports no_audio when the chime has no enabled slot', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': { json: { data: { attributes: { audio: { customizable_slots: [] } } } } } });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('no_audio');
  });

  it('reports failed — not rang — when Ring answers 200 without status "completed"', async () => {
    const r = ring({
      '/c1/status': STATUS(true, false),
      '/c1/configurations': CONFIG,
      '/c1/media/audio/playback': { json: { data: { attributes: { status: 'queued' } } } },
    });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('failed');
  });

  it('reports failed on an API error, and calls playback exactly once — no retry', async () => {
    const r = ring({ '/c1/status': STATUS(true, false), '/c1/configurations': CONFIG, '/c1/media/audio/playback': { status: 403, json: { errors: [{ code: 'FORBIDDEN' }] } } });
    expect(await ringChime(r.client, 'c1', 'ring-appstore-event-1')).toBe('failed');
    expect(r.calls.filter((c) => c.url.endsWith('/media/audio/playback'))).toHaveLength(1);
  });
});

describe('summariseChimeOutcomes', () => {
  it('rang if any chime rang — two chimes, one offline', () => {
    expect(summariseChimeOutcomes(['offline', 'rang'])).toBe('rang');
  });
  it('snoozed beats no_audio beats offline beats failed', () => {
    expect(summariseChimeOutcomes(['failed', 'snoozed'])).toBe('snoozed');
    expect(summariseChimeOutcomes(['offline', 'no_audio'])).toBe('no_audio');
    expect(summariseChimeOutcomes(['failed', 'offline'])).toBe('offline');
  });
  it('no_chime for an empty list', () => {
    expect(summariseChimeOutcomes([])).toBe('no_chime');
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `npx vitest run services/connectors/ring/src/__tests__/chime.test.ts`
Expected: FAIL — cannot find module `../chime.js`.

- [ ] **Step 7: Implement `chime.ts`**

Create `services/connectors/ring/src/chime.ts`:

```ts
/**
 * M1 — the hallway chime. Ring docs: Chimes (Early Access), verified 2026-10-01.
 *
 *   GET  /v1/devices/{id}/status          online, audio.snooze.active
 *   GET  /v1/devices/{id}/configurations  audio.customizable_slots[] (the app's slots)
 *   POST /v1/devices/{id}/media/audio/playback
 *        { data: { type: 'audio', attributes: { audio_ref } } } → 200 { status: 'completed' }
 *
 * A chime is an indoor speaker, so this tells the house, not the visitor
 * (spec D1). Playback makes a sound in someone's home: it is only ever called
 * from an explicit button press, exactly once, never retried (Ring best
 * practice #6, spec D4).
 */
import { RingApiError, type RingClient } from './client.js';
import { parseChimeSlots, parsePlaybackStatus } from './jsonapi.js';
import type { ChimeOutcome, RingDevice } from './types.js';

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Chimes Wick may sound right now, as far as the (possibly cached) list knows. */
export function playableChimes(devices: readonly RingDevice[]): RingDevice[] {
  return devices.filter((d) => d.capabilities.chime && d.online && d.snoozed !== true);
}

/** Phase 1's question: is the button worth drawing? */
export function hasHallwayChime(devices: readonly RingDevice[]): boolean {
  return playableChimes(devices).length > 0;
}

async function readStatus(client: RingClient, chimeId: string): Promise<{ online: boolean; snoozed: boolean }> {
  const doc = await client.get(`/v1/devices/${chimeId}/status`);
  const data = isRecord(doc) && isRecord(doc.data) ? doc.data : {};
  const attrs = isRecord(data.attributes) ? data.attributes : {};
  const audio = isRecord(attrs.audio) ? attrs.audio : {};
  const snooze = isRecord(audio.snooze) ? audio.snooze : {};
  return { online: attrs.online === true, snoozed: snooze.active === true };
}

/**
 * Play one chime's slot audio. Re-reads status first: the list Phase 1 used
 * can be a minute old, and a chime snoozed since then must stay quiet.
 */
export async function ringChime(client: RingClient, chimeId: string, slotEvent: string): Promise<ChimeOutcome> {
  try {
    const status = await readStatus(client, chimeId);
    if (!status.online) return 'offline';
    if (status.snoozed) return 'snoozed';

    const slots = parseChimeSlots(await client.get(`/v1/devices/${chimeId}/configurations`)).filter((s) => !s.disabled);
    const slot = slots.find((s) => s.event === slotEvent) ?? slots[0];
    if (!slot) return 'no_audio';

    const played = await client.post(`/v1/devices/${chimeId}/media/audio/playback`, {
      data: { type: 'audio', attributes: { audio_ref: slot.audioRef } },
    });
    return parsePlaybackStatus(played) === 'completed' ? 'rang' : 'failed';
  } catch (err) {
    if (err instanceof RingApiError) return 'failed';
    throw err;
  }
}

/** Precedence: the most useful true thing to tell the resident. */
const ORDER: readonly ChimeOutcome[] = ['rang', 'snoozed', 'no_audio', 'offline', 'failed'];

export function summariseChimeOutcomes(outcomes: readonly ChimeOutcome[]): ChimeOutcome | 'no_chime' {
  if (outcomes.length === 0) return 'no_chime';
  return ORDER.find((o) => outcomes.includes(o)) ?? 'failed';
}
```

Add to `services/connectors/ring/src/index.ts`: `export * from './chime.js';`

- [ ] **Step 8: Run chime tests to verify they pass**

Run: `npx vitest run services/connectors/ring/src/__tests__/chime.test.ts`
Expected: PASS

- [ ] **Step 9: Write the failing `cachedDevices` test**

Append to `services/connectors/ring/src/__tests__/deviceCache.test.ts` (import `cachedDevices` alongside `cachedDeviceLookup`):

```ts
describe('cachedDevices', () => {
  it('serves find() and all() from one fetch — Phase 1 needs both the camera and the chime', async () => {
    let calls = 0;
    const devices = cachedDevices({
      list: async () => {
        calls++;
        return [device];
      },
      now: () => 0,
    });
    expect(await devices.find(device.id)).toEqual(device);
    expect(await devices.all()).toEqual([device]);
    expect(calls).toBe(1);
  });
});
```

(`device` is the fixture already defined at the top of that file.)

- [ ] **Step 10: Run to verify failure**

Run: `npx vitest run services/connectors/ring/src/__tests__/deviceCache.test.ts`
Expected: FAIL — `cachedDevices is not a function`.

- [ ] **Step 11: Implement `cachedDevices`**

In `services/connectors/ring/src/deviceCache.ts`, update the header comment's first paragraph to say Phase 1 needs the doorbell *and* whether a playable chime exists, then replace the body of `cachedDeviceLookup` with a shared cache:

```ts
export interface CachedDevices {
  find(deviceId: string): Promise<RingDevice | undefined>;
  all(): Promise<readonly RingDevice[]>;
}

export function cachedDevices(options: CachedDeviceLookupOptions): CachedDevices {
  const { list } = options;
  const cacheMs = options.cacheMs ?? 60_000;
  const now = options.now ?? Date.now;

  let cached: { devices: readonly RingDevice[]; fetchedAt: number } | null = null;
  let inFlight: Promise<readonly RingDevice[]> | null = null;

  async function fetch(): Promise<readonly RingDevice[]> {
    // Single-flight: a burst of near-simultaneous door events on a cold cache
    // should issue one Ring call, not one per event.
    inFlight ??= (async () => {
      try {
        const devices = await list();
        cached = { devices, fetchedAt: now() };
        return devices;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  const all = async () => (cached && now() - cached.fetchedAt < cacheMs ? cached.devices : fetch());
  return { all, find: async (deviceId) => (await all()).find((d) => d.id === deviceId) };
}

export function cachedDeviceLookup(options: CachedDeviceLookupOptions): DeviceLookup {
  return cachedDevices(options).find;
}
```

- [ ] **Step 12: Run the whole ring connector suite**

Run: `npx vitest run services/connectors/ring`
Expected: PASS (all files)

- [ ] **Step 13: Commit**

```bash
git add services/connectors/ring
git commit -m "feat(ring): chimes are devices that say chime.play — discovery, slots, playback"
```

---

### Task 2: Contracts, patch merge, and the Door Card's actions

**Files:**
- Modify: `packages/contracts/src/card.ts`
- Modify: `services/agent/src/egress.ts` (`applyCardPatch`)
- Modify: `apps/tv-vega/src/headless/QueueStore.ts` (`applyPatch`)
- Modify: `services/agent/src/agents/door/index.ts` (`DoorCardInput`, `actionsFor`)
- Modify: `services/agent/src/agents/door/lambda.ts` (`RouteDeps`, `handler`)
- Modify: `scripts/door-card-demo.ts`
- Test: `services/agent/src/__tests__/egress.test.ts`, `apps/tv-vega/src/headless/__tests__/QueueStore.test.ts`, `services/agent/src/agents/door/__tests__/door.test.ts`, `…/handle.test.ts`, `…/lambda.test.ts`

**Interfaces:**
- Consumes: `hasHallwayChime(devices)`, `cachedDevices()` (Task 1).
- Produces:
  - `DoorCard.notice?: string`; `CardPatch.notice?: string`; `CardPatch.actions?: readonly CardAction[]`
  - `export const DOOR_ACTIONS = { watchLive: 'watch_live', hallwayChime: 'hallway_chime', dismiss: 'dismiss' } as const` (contracts)
  - `DoorCardInput.hallwayChime: boolean`
  - `RouteDeps.hasHallwayChime: () => Promise<boolean>`

- [ ] **Step 1: Failing tests for the patch merge (both sides)**

Append to `describe('applyCardPatch', …)` in `services/agent/src/__tests__/egress.test.ts`:

```ts
  it('merges a notice and replaces the actions — M1 feedback', () => {
    const patched = applyCardPatch(door, {
      cardId: 'door-1',
      notice: 'The hallway chime rang.',
      actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }],
    });
    expect(patched.type === 'DOOR' && patched.notice).toBe('The hallway chime rang.');
    expect(patched.actions.map((a) => a.id)).toEqual(['dismiss']);
  });

  it('never lets a patch carry more than three actions onto the card', () => {
    const four = ['a', 'b', 'c', 'd'].map((id) => ({ id, label: id, kind: 'secondary' as const }));
    expect(applyCardPatch(door, { cardId: 'door-1', actions: four }).actions).toHaveLength(3);
  });
```

Append to `apps/tv-vega/src/headless/__tests__/QueueStore.test.ts`, inside the describe that already tests `applyPatch` (reuse its store/card setup — the existing tests upsert a DOOR card with id `c1`):

```ts
  it('applies a notice and replaces actions, exactly as egress.applyCardPatch does', async () => {
    await store.applyPatch({ cardId: 'c1', notice: 'The hallway chime rang.', actions: [{ id: 'dismiss', label: 'Not now', kind: 'dismiss' }] });
    const [q] = await store.readAll();
    expect(q!.card.type === 'DOOR' && q!.card.notice).toBe('The hallway chime rang.');
    expect(q!.card.actions.map((a) => a.id)).toEqual(['dismiss']);
  });
```

- [ ] **Step 2: Failing tests for the door actions**

In `services/agent/src/agents/door/__tests__/door.test.ts` change the `build` helper to take the household's chime availability instead of the device's:

```ts
const device: RingDevice = {
  id: 'ava1.ring.device.ABNJQ',
  name: 'Front Door',
  online: true,
  capabilities: { motion: true, image: true, chime: false },
};

const build = (hallwayChime: boolean) =>
  buildPhaseOneCard({
    event,
    device,
    hallwayChime,
    householdId: 'hh-1',
    correlationId: 'corr-abc',
    now: 1789455094000,
  });
```

(delete the old `device = (chime) => …` factory) and replace the two chime tests with:

```ts
  it('offers all three buttons when the household has a playable hallway chime', () => {
    const actions = build(true).actions;
    expect(actions.map((a) => a.id)).toEqual(['watch_live', 'hallway_chime', 'dismiss']);
    expect(actions[1]!.label).toBe('Ring the hallway chime');
  });

  it('drops the chime button when there is no chime to ring, rather than offering one that fails', () => {
    expect(build(false).actions.map((a) => a.id)).toEqual(['watch_live', 'dismiss']);
  });
```

Leave the existing third test (`for (const chime of [true, false])` → rename the loop variable to `hallwayChime`) asserting `≤ MAX_CARD_ACTIONS`.

In `…/handle.test.ts` add `hallwayChime: false,` to every `DoorCardInput` literal. In `…/lambda.test.ts` add `hasHallwayChime: vi.fn(async () => false),` to `baseDeps()` and append:

```ts
  it('asks the household-level question for the chime button, not the doorbell', async () => {
    const deps = baseDeps({ hasHallwayChime: vi.fn(async () => true) });
    await routeRingEvent(detail, deps);
    const sent = vi.mocked(deps.sendToDevice).mock.calls[0]![0]!;
    expect(sent.card.actions.map((a) => a.id)).toContain('hallway_chime');
  });
```

- [ ] **Step 3: Run to verify failure**

Run: `npx vitest run services/agent/src apps/tv-vega/src/headless`
Expected: FAIL — type errors on `notice`/`actions`/`hallwayChime`, and wrong action ids.

- [ ] **Step 4: Implement contracts**

In `packages/contracts/src/card.ts`: add to `DoorCard`

```ts
  /** One plain sentence about something the resident just did (M1: whether the chime rang). */
  readonly notice?: string;
```

add to `CardPatch`

```ts
  /** M1 feedback. See DoorCard.notice. */
  readonly notice?: string;
  /** Replaces the card's actions — e.g. without the chime button once it has rung. Capped at MAX_CARD_ACTIONS on merge. */
  readonly actions?: readonly CardAction[];
```

and after `MAX_CARD_ACTIONS`:

```ts
/** A DOOR card's action ids. Only `dismiss` removes the card on press. */
export const DOOR_ACTIONS = {
  watchLive: 'watch_live',
  hallwayChime: 'hallway_chime',
  dismiss: 'dismiss',
} as const;
```

- [ ] **Step 5: Implement both merges**

`services/agent/src/egress.ts` `applyCardPatch` — add to the returned object:

```ts
    ...(patch.notice === undefined ? {} : { notice: patch.notice }),
    ...(patch.actions === undefined ? {} : { actions: patch.actions.slice(0, MAX_CARD_ACTIONS) }),
```

and import `MAX_CARD_ACTIONS` from `@wick/contracts`. Make the identical two additions to the `card:` spread in `apps/tv-vega/src/headless/QueueStore.ts` `applyPatch` (import `MAX_CARD_ACTIONS` there too). Both headers already say they mirror each other; keep it true.

- [ ] **Step 6: Implement the door actions**

`services/agent/src/agents/door/index.ts`:

In `DoorCardInput` add:

```ts
  /** Spec §4.2: a playable Ring Chime exists in the household (from the cached device list). */
  readonly hallwayChime: boolean;
```

Replace `actionsFor` and its comment:

```ts
/**
 * The three buttons — minus any the household cannot actually do.
 *
 * The middle one rings the hallway chime: an indoor speaker, so it tells the
 * rest of the house, not the visitor (spec D1). It is only offered when a
 * playable chime exists; a button that fails when pressed is worse than one
 * that was never there (D6).
 */
function actionsFor(hallwayChime: boolean): readonly CardAction[] {
  const actions: CardAction[] = [{ id: DOOR_ACTIONS.watchLive, label: 'Watch live', kind: 'primary' }];

  if (hallwayChime) {
    actions.push({ id: DOOR_ACTIONS.hallwayChime, label: 'Ring the hallway chime', kind: 'secondary' });
  }

  // There is always a way out, and it is always last.
  actions.push({ id: DOOR_ACTIONS.dismiss, label: 'Not now', kind: 'dismiss' });

  return actions.slice(0, MAX_CARD_ACTIONS);
}
```

In `buildPhaseOneCard` destructure `hallwayChime` and call `actionsFor(hallwayChime)`; import `DOOR_ACTIONS`. `device` is still used by callers but no longer by `actionsFor` — keep it in `DoorCardInput` (Plan B needs the camera id).

`services/agent/src/agents/door/lambda.ts`:
- Add to `RouteDeps`: `/** M1. A playable Ring Chime exists — from the same cached list as findDevice, so no extra Ring call. */ readonly hasHallwayChime: () => Promise<boolean>;`
- In `routeRingEvent`, before `handleDoorEvent`: `const hallwayChime = await deps.hasHallwayChime().catch(() => false);` and pass `hallwayChime` in the input object.
- In `handler`: replace the `lookupDevice` module variable with `let devices: CachedDevices | undefined;` then `devices ??= cachedDevices({ list: () => listDevices(ringClient) });` and pass `findDevice: devices.find, hasHallwayChime: async () => hasHallwayChime(await devices!.all()),`. Import `cachedDevices`, `hasHallwayChime`, `type CachedDevices` from `@wick/ring` (drop `cachedDeviceLookup`).

`scripts/door-card-demo.ts`: replace the `device.capabilities.chime` block with

```ts
  const all = await listDevices(client);
  const hallwayChime = hasHallwayChime(all);
  if (!hallwayChime) console.log('\n   "Ring the hallway chime" is absent: no playable Ring Chime on this account.');
```

(pass `hallwayChime` into its `buildPhaseOneCard` call) and change the device line's `chime=${…}` to `chime.play=${d.capabilities.chime}`.

- [ ] **Step 7: Run everything**

Run: `npm run typecheck && npm run typecheck:scripts && npx vitest run`
Expected: PASS

- [ ] **Step 8: Commit**

```bash
git add packages/contracts services/agent apps/tv-vega/src/headless scripts/door-card-demo.ts
git commit -m "feat(door): offer 'Ring the hallway chime' from the household's chimes, and let a patch carry a notice"
```

---

### Task 3: TV — the chime button keeps the card; the notice shows on it

**Files:**
- Create: `apps/tv-vega/src/cards/cardActions.ts`
- Test: `apps/tv-vega/src/cards/__tests__/cardActions.test.ts`
- Modify: `apps/tv-vega/src/App.tsx` (`handleAction`)
- Modify: `apps/tv-vega/src/cards/DoorCard.tsx`

**Interfaces:**
- Consumes: `DOOR_ACTIONS`, `DoorCard.notice` (Task 2).
- Produces: `removesCard(card: Card, actionId: string): boolean` — Plan B extends it for `watch_live`.

- [ ] **Step 1: Failing test**

Create `apps/tv-vega/src/cards/__tests__/cardActions.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import type { Card } from '@wick/contracts';
import { removesCard } from '../cardActions.js';

const door = { type: 'DOOR', id: 'd', householdId: 'h', correlationId: 'c', createdAt: 0, line: 'x', actions: [] } as Card;
const week = { type: 'WEEK', id: 'week-2026-W40', householdId: 'h', correlationId: 'c', createdAt: 0, isoWeek: '2026-W40', text: 't', actions: [] } as Card;

describe('removesCard', () => {
  it('keeps a door card on screen while the chime answer is on its way', () => {
    expect(removesCard(door, 'hallway_chime')).toBe(false);
  });
  it('removes a door card on Not now', () => {
    expect(removesCard(door, 'dismiss')).toBe(true);
  });
  it('removes every other card type on any action, as before', () => {
    expect(removesCard(week, 'seen')).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run apps/tv-vega/src/cards/__tests__/cardActions.test.ts`
Expected: FAIL — cannot find module.

- [ ] **Step 3: Implement**

Create `apps/tv-vega/src/cards/cardActions.ts`:

```ts
/**
 * Which presses take a card off the screen. Pure and RN-import-free, like
 * messageActions.ts. The device still never decides *what* happens — the
 * agent plane does — only whether the thing the resident pressed is finished
 * from the screen's point of view.
 *
 * The chime button is not: its answer ("The hallway chime rang.") arrives as a
 * patch onto this same card a second later (M1, spec §4.2).
 */
import { DOOR_ACTIONS, type Card } from '@wick/contracts';

export function removesCard(card: Card, actionId: string): boolean {
  if (card.type !== 'DOOR') return true;
  return actionId !== DOOR_ACTIONS.hallwayChime;
}
```

In `apps/tv-vega/src/App.tsx` replace `handleAction`:

```tsx
  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      if (card && card.id === cardId && removesCard(card.card, actionId)) {
        void store.remove(cardId);
        setCard(null);
      }
      // The outbox is drained by whichever process holds the channel — this
      // one, since FL-014 (holdCardChannel above).
      void store.enqueueOutbound({ t: 'card_action', cardId, action: actionId, at: Date.now() });
    },
    [store, card],
  );
```

and `import { removesCard } from './cards/cardActions.js';`.

In `apps/tv-vega/src/cards/DoorCard.tsx` pass the notice as `TwoPhaseCard`'s children (rendered above the reserved detail slot, so arriving text displaces nothing below it):

```tsx
      >
        {card.notice ? <Text style={styles.notice} accessibilityLiveRegion="polite">{card.notice}</Text> : null}
      </TwoPhaseCard>
```

(change the self-closing `<TwoPhaseCard … />` to open/close), import `Text` from `@amazon-devices/react-native-kepler` and `fontSize, safe` from `@wick/vega-calm-ui`, and add the style:

```ts
  notice: {
    color: safe.ink,
    fontSize: fontSize('body'),
    lineHeight: fontSize('body') * 1.4,
  },
```

Update the header comment's second bullet: "The middle button is absent when the household has no playable Ring Chime (Phase 1 decides from the device list); pressing it keeps the card and a patch adds the notice."

- [ ] **Step 4: Run tests + Vega typecheck**

Run: `npx vitest run apps/tv-vega && npm run typecheck:vega`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/tv-vega/src
git commit -m "feat(vega): the chime button keeps its card, and the card shows what happened"
```

---

### Task 4: `route.mjs` publishes server-side card actions to EventBridge

**Files:**
- Create: `services/edge-device/lambda/card-action-event.mjs`
- Test: `services/edge-device/lambda/__tests__/card-action-event.test.ts`
- Modify: `services/edge-device/lambda/route.mjs`
- Modify: `infra/transport.tf` (`ws_route` env + IAM)

**Interfaces:**
- Produces: EventBridge event `{ Source: 'wick.device', DetailType: 'card.action', Detail: { householdId, deviceId, cardId, action, at } }` on bus `var EVENT_BUS_NAME`. Consumed by Task 5.
- `shouldPublish(action: string): boolean`, `buildCardActionEntry({ busName, householdId, deviceId, cardId, action, at })`.

- [ ] **Step 1: Failing test**

Create `services/edge-device/lambda/__tests__/card-action-event.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { buildCardActionEntry, shouldPublish } from '../card-action-event.mjs';

describe('card-action-event', () => {
  it('publishes only the actions the agent plane has to carry out', () => {
    expect(shouldPublish('hallway_chime')).toBe(true);
    expect(shouldPublish('dismiss')).toBe(false);
    expect(shouldPublish('seen')).toBe(false);
  });

  it('builds a wick.device / card.action entry with ids only — never card content', () => {
    const entry = buildCardActionEntry({ busName: 'wick', householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: 5 });
    expect(entry).toEqual({
      EventBusName: 'wick',
      Source: 'wick.device',
      DetailType: 'card.action',
      Detail: JSON.stringify({ householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: 5 }),
    });
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run services/edge-device/lambda/__tests__/card-action-event.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `services/edge-device/lambda/card-action-event.mjs`:

```js
/**
 * Which device card actions the agent plane must act on, and the event that
 * tells it to. Pure; route.mjs owns the EventBridge client.
 *
 * Only ids travel — the card itself stays in DynamoDB, where the consumer
 * re-reads it (and so can tell a live card from one that aged out).
 */
const SERVER_ACTIONS = new Set(['hallway_chime']);

export function shouldPublish(action) {
  return SERVER_ACTIONS.has(action);
}

export function buildCardActionEntry({ busName, householdId, deviceId, cardId, action, at }) {
  return {
    EventBusName: busName,
    Source: 'wick.device',
    DetailType: 'card.action',
    Detail: JSON.stringify({ householdId, deviceId, cardId, action, at }),
  };
}
```

In `route.mjs`:
- `import { EventBridgeClient, PutEventsCommand } from '@aws-sdk/client-eventbridge';`
- `import { buildCardActionEntry, shouldPublish } from './card-action-event.mjs';`
- `const events = new EventBridgeClient({}); const BUS = process.env.EVENT_BUS_NAME;`
- After `if (deviceEvent.t === 'card_action') await retireActedCard(...)`:

```js
    if (deviceEvent.t === 'card_action' && typeof deviceEvent.action === 'string' && shouldPublish(deviceEvent.action)) {
      await publishCardAction({ householdId, deviceId, cardId: deviceEvent.cardId, action: deviceEvent.action, at: deviceEvent.at });
    }
```

- Add the function next to `retireActedCard`:

```js
/**
 * Hand the press to the agent plane (M1). Logged, never thrown: the press is
 * already on the timeline, and the card keeps its button, so pressing again
 * is the resident's retry — the consumer's once-per-card claim makes that safe.
 */
async function publishCardAction(detail) {
  try {
    const res = await events.send(new PutEventsCommand({ Entries: [buildCardActionEntry({ busName: BUS, ...detail })] }));
    if (res.FailedEntryCount) console.error('card_action_publish_rejected', { cardId: detail.cardId, code: res.Entries?.[0]?.ErrorCode });
  } catch (err) {
    console.error('card_action_publish_failed', { cardId: detail.cardId, err: err?.name });
  }
}
```

- Add one paragraph to the header comment: "A card_action the agent plane must carry out (today only M1's `hallway_chime`) is also published to EventBridge as `wick.device` / `card.action` — see card-action-event.mjs."

`infra/transport.tf`:
- `aws_lambda_function.ws_route` → `variables = { TABLE_NAME = aws_dynamodb_table.wick.name, EVENT_BUS_NAME = aws_cloudwatch_event_bus.wick.name }`
- `data "aws_iam_policy_document" "ws_route"` add:

```hcl
  statement {
    sid       = "HandCardActionsToTheAgentPlane"
    actions   = ["events:PutEvents"]
    resources = [aws_cloudwatch_event_bus.wick.arn]
  }
```

- [ ] **Step 4: Run tests, lint, fmt**

Run: `npx vitest run services/edge-device && npm run lint && terraform -chdir=infra fmt -check -recursive`
Expected: PASS (if `fmt -check` reports a file, run `npm run tf:fmt` and re-check)

- [ ] **Step 5: Commit**

```bash
git add services/edge-device infra/transport.tf
git commit -m "feat(edge-device): hand the chime press to the agent plane over EventBridge"
```

---

### Task 5: `agent-card-action` — ring once, tell the resident

**Files:**
- Create: `services/agent/src/agents/door/actions.ts`
- Test: `services/agent/src/agents/door/__tests__/actions.test.ts`
- Create: `services/agent/src/agents/door/actionLambda.ts`
- Modify: `scripts/build-lambda.mjs` (new target)
- Create: `infra/card-action.tf`

**Interfaces:**
- Consumes: Task 1 `ringChime`, `summariseChimeOutcomes`, `listDevices`; Task 2 `CardPatch.notice/actions`, `DOOR_ACTIONS`; Task 4 event detail; `egress.sendPatchToDevice(patch, householdId)`.
- Produces: `handleCardAction(detail: Record<string, unknown>, deps: CardActionDeps): Promise<CardActionResult>`; `CHIME_NOTICE`.

- [ ] **Step 1: Failing tests**

Create `services/agent/src/agents/door/__tests__/actions.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest';
import type { CardPatch, QueuedCard } from '@wick/contracts';
import type { RingDevice } from '@wick/ring';
import { CHIME_NOTICE, handleCardAction, type CardActionDeps } from '../actions.js';

const NOW = 1_790_000_000_000;
const doorCard = (over: Partial<QueuedCard> = {}): QueuedCard => ({
  id: 'door-abc',
  urgency: 'DOOR',
  queuedAt: NOW - 30_000,
  expiresAt: NOW + 270_000,
  shownCount: 1,
  card: {
    type: 'DOOR', id: 'door-abc', householdId: 'margaret', correlationId: 'corr', createdAt: NOW - 30_000,
    line: "Someone's at the front door.",
    actions: [
      { id: 'watch_live', label: 'Watch live', kind: 'primary' },
      { id: 'hallway_chime', label: 'Ring the hallway chime', kind: 'secondary' },
      { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
    ],
  },
  ...over,
});
const chime = (id: string): RingDevice => ({ id, name: id, online: true, capabilities: { motion: false, image: false, chime: true } });
const detail = { householdId: 'margaret', deviceId: 'wick-tv', cardId: 'door-abc', action: 'hallway_chime', at: NOW };

function deps(over: Partial<CardActionDeps> = {}): CardActionDeps {
  return {
    loadCard: vi.fn(async () => doorCard()),
    claimOnce: vi.fn(async () => true),
    listDevices: vi.fn(async () => [chime('c1')]),
    ringChime: vi.fn(async () => 'rang' as const),
    sendPatch: vi.fn(async (_p: CardPatch) => {}),
    now: () => NOW,
    ...over,
  };
}

describe('handleCardAction', () => {
  it('rings, then patches the notice and removes the chime button from the card', async () => {
    const d = deps();
    expect(await handleCardAction(detail, d)).toBe('rang');
    expect(d.ringChime).toHaveBeenCalledWith('c1');
    const patch = vi.mocked(d.sendPatch).mock.calls[0]![0];
    expect(patch).toEqual({
      cardId: 'door-abc',
      notice: 'The hallway chime rang.',
      actions: [
        { id: 'watch_live', label: 'Watch live', kind: 'primary' },
        { id: 'dismiss', label: 'Not now', kind: 'dismiss' },
      ],
    });
  });

  it('rings exactly once for a double press or a redelivered event', async () => {
    const d = deps({ claimOnce: vi.fn(async () => false) });
    expect(await handleCardAction(detail, d)).toBe('duplicate');
    expect(d.ringChime).not.toHaveBeenCalled();
    expect(d.sendPatch).not.toHaveBeenCalled();
  });

  it('never rings for a card that aged out while it sat on screen', async () => {
    const d = deps({ loadCard: vi.fn(async () => doorCard({ expiresAt: NOW - 1 })) });
    expect(await handleCardAction(detail, d)).toBe('stale');
    expect(d.claimOnce).not.toHaveBeenCalled();
    expect(d.ringChime).not.toHaveBeenCalled();
  });

  it('ignores actions it does not own, and cards that are not door cards', async () => {
    expect(await handleCardAction({ ...detail, action: 'dismiss' }, deps())).toBe('ignored');
    const week = deps({ loadCard: vi.fn(async () => ({ ...doorCard(), card: { ...doorCard().card, type: 'WEEK', isoWeek: 'w', text: 't' } }) as unknown as QueuedCard) });
    expect(await handleCardAction(detail, week)).toBe('unknown_card');
    expect(await handleCardAction({ householdId: 'x' }, deps())).toBe('ignored');
  });

  it('rings every chime in the house and reports the most useful truth', async () => {
    const ring = vi.fn(async (id: string) => (id === 'c1' ? ('offline' as const) : ('rang' as const)));
    const d = deps({ listDevices: vi.fn(async () => [chime('c1'), chime('c2')]), ringChime: ring });
    expect(await handleCardAction(detail, d)).toBe('rang');
    expect(ring).toHaveBeenCalledTimes(2);
  });

  it('says plainly when the chime is snoozed, and still removes the button', async () => {
    const d = deps({ ringChime: vi.fn(async () => 'snoozed' as const) });
    expect(await handleCardAction(detail, d)).toBe('snoozed');
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0].notice).toBe(CHIME_NOTICE.snoozed);
  });

  it('says there is no chime when the household has none any more', async () => {
    const d = deps({ listDevices: vi.fn(async () => []) });
    expect(await handleCardAction(detail, d)).toBe('no_chime');
    expect(vi.mocked(d.sendPatch).mock.calls[0]![0].notice).toBe("There's no hallway chime Wick can reach.");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run services/agent/src/agents/door/__tests__/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `actions.ts`**

```ts
/**
 * The Door Card's server-side buttons. Today: M1, the hallway chime.
 *
 * Deterministic on purpose — no model decides to make a sound in someone's
 * home (spec D4; Ring best practice #6). The order is the safety argument:
 * a card that is not a live DOOR card never rings; a card is claimed before
 * anything is played, so a double press or an EventBridge redelivery rings
 * once; and the resident is always told what happened, including "nothing".
 */
import { DOOR_ACTIONS, type CardPatch, type QueuedCard } from '@wick/contracts';
import { summariseChimeOutcomes, type ChimeOutcome, type RingDevice } from '@wick/ring';

export const CHIME_NOTICE: Record<ChimeOutcome | 'no_chime', string> = {
  rang: 'The hallway chime rang.',
  snoozed: 'The hallway chime is snoozed, so it stayed quiet.',
  offline: "The hallway chime didn't answer.",
  failed: "The hallway chime didn't answer.",
  no_audio: 'The hallway chime has no sound set up for Wick.',
  no_chime: "There's no hallway chime Wick can reach.",
};

export type CardActionResult = ChimeOutcome | 'no_chime' | 'ignored' | 'unknown_card' | 'stale' | 'duplicate';

export interface CardActionDeps {
  readonly loadCard: (householdId: string, cardId: string) => Promise<QueuedCard | undefined>;
  /** Conditional write of CHIME#<cardId>; false when it already existed. */
  readonly claimOnce: (householdId: string, cardId: string) => Promise<boolean>;
  /** Fresh from Ring — not the Phase 1 cache; this is the moment of truth. */
  readonly listDevices: () => Promise<readonly RingDevice[]>;
  readonly ringChime: (chimeId: string) => Promise<ChimeOutcome>;
  readonly sendPatch: (patch: CardPatch) => Promise<void>;
  readonly now: () => number;
}

interface Detail {
  readonly householdId: string;
  readonly cardId: string;
  readonly action: string;
}

function parse(detail: Record<string, unknown>): Detail | null {
  const { householdId, cardId, action } = detail;
  if (typeof householdId !== 'string' || typeof cardId !== 'string' || typeof action !== 'string') return null;
  return { householdId, cardId, action };
}

export async function handleCardAction(raw: Record<string, unknown>, deps: CardActionDeps): Promise<CardActionResult> {
  const detail = parse(raw);
  if (!detail || detail.action !== DOOR_ACTIONS.hallwayChime) return 'ignored';

  const queued = await deps.loadCard(detail.householdId, detail.cardId);
  if (!queued || queued.card.type !== 'DOOR') return 'unknown_card';
  if (queued.expiresAt !== undefined && deps.now() > queued.expiresAt) return 'stale';

  if (!(await deps.claimOnce(detail.householdId, detail.cardId))) return 'duplicate';

  const chimes = (await deps.listDevices()).filter((d) => d.capabilities.chime);
  const outcomes = await Promise.all(chimes.map((c) => deps.ringChime(c.id)));
  const result = summariseChimeOutcomes(outcomes);

  await deps.sendPatch({
    cardId: detail.cardId,
    notice: CHIME_NOTICE[result],
    actions: queued.card.actions.filter((a) => a.id !== DOOR_ACTIONS.hallwayChime),
  });
  return result;
}
```

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run services/agent/src/agents/door/__tests__/actions.test.ts`
Expected: PASS

- [ ] **Step 5: Composition root, bundle, infra**

Create `services/agent/src/agents/door/actionLambda.ts`:

```ts
/**
 * EventBridge `wick.device` / `card.action` → handleCardAction. Thin
 * composition, left untested the same way door/lambda.ts's handler is.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import type { QueuedCard } from '@wick/contracts';
import { RingClient, listDevices, ringChime, secretsManagerTokenProvider } from '@wick/ring';
import { handleCardAction } from './actions.js';
import { sendPatchToDevice } from '../../egress.js';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
const SLOT = process.env.WICK_CHIME_SLOT_EVENT ?? 'ring-appstore-event-1';
const DAY_S = 24 * 60 * 60;

export const handler = async (evt: { detail: Record<string, unknown> }): Promise<void> => {
  const ring = new RingClient({ getToken: secretsManagerTokenProvider() });
  const householdId = String(evt.detail.householdId ?? '');

  const result = await handleCardAction(evt.detail, {
    loadCard: async (hh, cardId) => {
      const res = await ddb.send(new GetItemCommand({ TableName: TABLE, Key: { pk: { S: `HH#${hh}` }, sk: { S: `CARD#${cardId}` } } }));
      return res.Item?.data?.S ? (JSON.parse(res.Item.data.S) as QueuedCard) : undefined;
    },
    claimOnce: async (hh, cardId) => {
      try {
        await ddb.send(new PutItemCommand({
          TableName: TABLE,
          Item: { pk: { S: `HH#${hh}` }, sk: { S: `CHIME#${cardId}` }, ttl: { N: String(Math.floor(Date.now() / 1000) + DAY_S) } },
          ConditionExpression: 'attribute_not_exists(pk)',
        }));
        return true;
      } catch (err) {
        if ((err as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw err;
      }
    },
    listDevices: () => listDevices(ring),
    ringChime: (chimeId) => ringChime(ring, chimeId, SLOT),
    sendPatch: (patch) => sendPatchToDevice(patch, householdId),
    now: Date.now,
  });

  console.log(JSON.stringify({ level: 'info', msg: 'card_action_handled', cardId: evt.detail.cardId, action: evt.detail.action, result }));
};
```

In `scripts/build-lambda.mjs` add to `TARGETS`:

```js
  {
    name: 'agent-card-action',
    entry: 'services/agent/src/agents/door/actionLambda.ts',
    outfile: 'services/agent/.build/card-action/index.mjs',
  },
```

Create `infra/card-action.tf`:

```hcl
# ---------------------------------------------------------------------------
# M1 — the Door Card's server-side buttons (spec §4.2).
#
#   TV card_action -> ws route.mjs -> EventBridge (wick.device / card.action)
#     -> agent-card-action (this) -> Ring Chime playback -> patch -> TV
#
# Deterministic: no model in this path (spec D4).
# ---------------------------------------------------------------------------

data "archive_file" "agent_card_action" {
  type        = "zip"
  source_dir  = "${path.module}/../services/agent/.build/card-action"
  output_path = "${path.module}/.build/agent-card-action.zip"
}

resource "aws_iam_role" "agent_card_action" {
  name               = "${local.prefix}-agent-card-action"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "agent_card_action_basic" {
  role       = aws_iam_role.agent_card_action.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "agent_card_action" {
  statement {
    sid       = "ReadRingToken"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.ring_tokens.arn]
  }

  statement {
    sid = "ReadCardClaimOncePatch"
    # GetItem: the CARD# being acted on. PutItem: the CHIME#<cardId> once-only
    # claim. UpdateItem + Query: sendPatchToDevice's merge and device lookup.
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }

  statement {
    sid       = "PushThePatch"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }
}

resource "aws_iam_role_policy" "agent_card_action" {
  name   = "${local.prefix}-agent-card-action"
  role   = aws_iam_role.agent_card_action.id
  policy = data.aws_iam_policy_document.agent_card_action.json
}

resource "aws_cloudwatch_log_group" "agent_card_action" {
  name              = "/aws/lambda/${local.prefix}-agent-card-action"
  retention_in_days = 14
}

resource "aws_lambda_function" "agent_card_action" {
  function_name = "${local.prefix}-agent-card-action"
  role          = aws_iam_role.agent_card_action.arn
  handler       = "index.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.agent_card_action.output_path
  source_code_hash = data.archive_file.agent_card_action.output_base64sha256

  # Device list + per chime: status, configurations, playback — all sequential
  # Ring round trips of ~0.3-0.8s each.
  timeout     = 15
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME            = aws_dynamodb_table.wick.name
      RING_TOKEN_SECRET_ID  = aws_secretsmanager_secret.ring_tokens.name
      WICK_CHIME_SLOT_EVENT = "ring-appstore-event-1"
    }
  }

  depends_on = [aws_cloudwatch_log_group.agent_card_action]
}

resource "aws_cloudwatch_event_rule" "card_actions" {
  name           = "${local.prefix}-card-actions"
  description    = "Door Card presses the agent plane carries out (M1)"
  event_bus_name = aws_cloudwatch_event_bus.wick.name

  event_pattern = jsonencode({
    source        = ["wick.device"]
    "detail-type" = ["card.action"]
    detail        = { action = ["hallway_chime"] }
  })
}

resource "aws_cloudwatch_event_target" "card_actions" {
  rule           = aws_cloudwatch_event_rule.card_actions.name
  event_bus_name = aws_cloudwatch_event_bus.wick.name
  arn            = aws_lambda_function.agent_card_action.arn

  # Playback is user-visible: never let EventBridge replay a press minutes
  # later. The CHIME# claim makes a retry harmless; this makes it rare.
  retry_policy {
    maximum_retry_attempts       = 0
    maximum_event_age_in_seconds = 60
  }
}

resource "aws_lambda_permission" "card_actions" {
  statement_id  = "AllowExecutionFromEventBridge"
  action        = "lambda:InvokeFunction"
  function_name = aws_lambda_function.agent_card_action.function_name
  principal     = "events.amazonaws.com"
  source_arn    = aws_cloudwatch_event_rule.card_actions.arn
}
```

Also update `.github/workflows/deploy-agent.yml`'s comment above `npm run build:lambda` to mention `card-action` alongside `door-event` (the build itself already builds every target).

- [ ] **Step 6: Build, validate, verify**

Run: `npm run build:lambda && terraform -chdir=infra fmt -recursive && AWS_PROFILE=wick-dev terraform -chdir=infra validate && npm run verify`
Expected: 3 bundles built (door-event, narrator-weekly, card-action); `Success! The configuration is valid.`; verify PASS.

- [ ] **Step 7: Commit**

```bash
git add services/agent scripts/build-lambda.mjs infra/card-action.tf .github/workflows/deploy-agent.yml
git commit -m "feat(door): ring the hallway chime once per card, and say what happened"
```

---

### Task 6: Say only what's true — copy across the repo

**Files:**
- Modify: `README.md` (The Door row), `docs/index.html` (hero copy), `docs/link.html` (Ring consent list item), `docs/WICK.md` (M1 section + walkthrough lines 283-285, 484-490, 827, 898), `docs/WICK-TECHNICAL.md` (§7.1 table row, §15 step 7), `FRICTION.md` (FL-006 follow-up), `services/connectors/ring/src/deviceCache.ts` + `scripts/ring-devices.ts` comments.

- [ ] **Step 1: Replace every "Just a moment" claim**

Run: `grep -rn "Just a moment\|just_a_moment" --include='*.md' --include='*.html' --include='*.ts' --include='*.mjs' . | grep -v node_modules | grep -v docs/superpowers`
Rewrite each hit to the hallway-chime framing. Canonical sentence for README / index.html:
"One button rings the Ring Chime in the hallway, so whoever else is home knows someone is at the door — and the card says whether it rang."
For `docs/link.html` consent list: "**Ring your Ring Chime** when you press "Ring the hallway chime" on a door card. Wick only ever plays the sound in its own chime slot, only when you press the button, and never while the chime is snoozed."
For `docs/WICK.md` M1: retitle "M1 · Ring the hallway chime — *the house hears it*" and add one paragraph: "Ring's developer API can play audio only on a Chime — an indoor speaker — and only the audio in the app's slot. It cannot speak through the doorbell. So M1 tells the house, not the visitor: a carer upstairs, a partner in the garden." Keep the rest of the narrative consistent (Margaret presses it; the chime down the hall rings; the card says "The hallway chime rang.").

- [ ] **Step 2: FL-006 follow-up**

Append to FL-006 in `FRICTION.md`, before its closing `---`:

```
**Update 2026-10-01:** Ring's Chimes page (Early Access) now documents the body —
`{"data":{"type":"audio","attributes":{"audio_ref":…}}}` — and the capability to
branch on: `audio.supported_actions` ∋ `chime.play`. Our four attempts were against
the Playground *camera*, which is not a chime at all; a chime is its own device.
The documentation gap that remains: nothing on the camera side says "this endpoint
is for chimes only", and the Playground has no chime to test against.
```

- [ ] **Step 3: Verify nothing still claims it**

Run: `grep -rn "Just a moment" --include='*.md' --include='*.html' . | grep -v node_modules | grep -v docs/superpowers | grep -v "FRICTION.md"`
Expected: no output (FRICTION.md keeps its historical record).

- [ ] **Step 4: Commit**

```bash
git add README.md docs FRICTION.md services/connectors/ring/src/deviceCache.ts scripts/ring-devices.ts
git commit -m "docs: M1 rings the hallway chime — say so everywhere, and close FL-006's loop"
```

---

### Task 7: Deploy and verify on the real system

**Files:** none new.

- [ ] **Step 1: Plan and confirm with the user** — `npm run build:lambda && AWS_PROFILE=wick-dev terraform -chdir=infra plan -out=m1.plan`. Show the summary (expected: 1 function + role/policy/log group/rule/target/permission added; `ws_route` env + policy changed). Apply only after the user says so: `AWS_PROFILE=wick-dev terraform -chdir=infra apply m1.plan`.
- [ ] **Step 2: No-chime path (Playground, today)** — `scripts/test-ring-webhook.sh` against the latest Playground event → the VVD card shows **two** buttons (Watch live, Not now). Correct: the account has no chime.
- [ ] **Step 3: Pipeline path without sound** — publish a synthetic `card.action` for the live card:
  `aws events put-events --entries '[{"EventBusName":"wick","Source":"wick.device","DetailType":"card.action","Detail":"{\"householdId\":\"margaret\",\"deviceId\":\"wick-tv\",\"cardId\":\"<id>\",\"action\":\"hallway_chime\",\"at\":0}"}]'`
  → CloudWatch `card_action_handled result:"no_chime"`, and the VVD card gains "There's no hallway chime Wick can reach." Publish it again → `result:"duplicate"`, no second patch.
- [ ] **Step 4: Real chime (when the user's Chime is on an account the app can see — spec D2, FL-010)** — `npx vite-node -c vitest.config.ts scripts/ring-devices.ts` lists a device with `supported_actions: ["chime.play"]`; ring the doorbell; press the button on the TV; the chime sounds; the card says "The hallway chime rang." Record it for the video.

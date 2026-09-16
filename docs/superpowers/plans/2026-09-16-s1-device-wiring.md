# S1 Device Wiring Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the on-device half of S1 (Door Card) — transport (device + edge Lambdas), pairing (device + backend binding), CardService, and the App.tsx/CardRenderer mount — so a `QueuedCard` produced by the door agent can reach a paired Fire TV over a real channel and render in the lower third.

**Architecture:** Two device-side transport implementations (`MqttChannel`, `WebSocketChannel`) behind one `DeviceChannel` interface and a `createDeviceChannel()` factory that tries MQTT first and falls back to WebSocket. A headless `CardService` holds the channel for the app's lifetime (it runs in its own process per `manifest.toml`) and hands cards to the UI process through a persisted `QueueStore` — the only channel two separate OS processes have. Pairing is six-digit-code-over-HTTP against new Lambdas that mint an RS256 device-bound JWT (INV-1). The WebSocket half of the transport gets real backend Lambdas (`connect`/`disconnect`/`route`) plus a real `sendToDevice()` in `services/agent/src/egress.ts` (INV-2's one legal egress point). The MQTT half ships as real client code without live IoT Core infra behind it yet — see **Scope decisions** below for why.

**Tech Stack:** TypeScript (device app, `services/agent`), plain `.mjs` Lambdas (matches `services/edge-ring/lambda`'s existing convention — deployed as-is, not part of the `tsc -b` graph), Terraform, `mqtt` (new dep, `apps/tv-vega`), `@aws-sdk/client-dynamodb` + `@aws-sdk/client-apigatewaymanagementapi` (new deps, `services/agent`), vitest.

**Spec:** `docs/WICK-TECHNICAL.md` §3.1–3.2 (component model), §4.1 (transport), §4.2 (pairing), §8.1 (data model), §9.1 (latency budget), §12.1 (real-data testing rule), §14 SP-5, §15 step 1. `AGENTS.md` INV-1, INV-2, INV-6.

## Global Constraints

- **INV-1**: the device holds exactly one device-bound JWT (RS256, 30-day expiry), scoped to card receipt + playback-event posting for one household. Never put a Ring/Bee/AWS credential in `apps/tv-vega`.
- **INV-2**: only `services/agent/src/egress.ts` may import a transport client from TypeScript source. Enforced by `eslint.config.js`'s `no-restricted-imports` rule, which also covers `apps/tv-vega/src/transport/{MqttChannel,WebSocketChannel}.ts` — any new file that imports those (or `mqtt` directly) must be added to that rule's `ignores`.
- **INV-6**: correlation ids and card ids thread through — ULIDs sort lexicographically by creation time, which the reconcile logic in Task 7 depends on.
- **No mocks in runtime code** (`npm run check:no-mocks`): nothing under `apps/tv-vega/src/**` outside `__tests__` may import a path matching `/mock/i`. Fixtures in this plan's tests are literal objects, not imports from a mock module — that satisfies the check.
- **Card rules** (`packages/vega-calm-ui` enforces at render): ≥32pt type, ≥7:1 contrast, ≤3 actions, no auto-dismiss, no red, ≤200ms animation. DOOR renders lower third, never pauses/ducks/silences.
- **Reconnect**: exponential backoff 1s → 30s, full jitter. On open, always reconcile: send `lastSeenCardId`, receive everything after it.
- **`exactOptionalPropertyTypes` + `strict`** are on repo-wide (`tsconfig.base.json`); `noUncheckedIndexedAccess` is off only for `apps/tv-vega` (FL-007). Build optional fields with conditional spread (`...(x === undefined ? {} : { x })`), never assign `undefined` directly.
- **Testing philosophy** (§12.1, confirmed by `services/edge-ring/lambda`'s existing split): pure logic gets real unit tests with real fixtures. Code that only exists to call AWS SDK clients (DynamoDB, API Gateway Management API, Secrets Manager) is *not* unit-tested with a faked SDK — it stays thin, imports the tested pure logic, and is verified for real once deployed. Do not mock `@aws-sdk/*`.
- **This pass is code + tests only.** No `terraform apply`, no on-hardware verification — that is explicitly deferred to a follow-up session with the user.

## Scope decisions (read before Task 6)

1. **MQTT-first-then-WebSocket** is implemented as *runtime* fallback behavior in `createDeviceChannel()` (Task 3), not as a static choice, because the actual SP-5 decision gate (docs/WICK-TECHNICAL.md §14) is "run `mqtt.js` over WSS on real Vega hardware for 4 hours and see." No such hardware is available this session. Building both, with MQTT attempted first and WebSocket as the automatic fallback, is the honest way to satisfy "try MQTT first" without fabricating a spike result.
2. **IoT Core infrastructure is not stood up in this pass.** `MqttChannel.ts` is a complete, real client against the documented per-device topic contract, ready to point at an IoT endpoint the moment `infra/transport.tf`'s WebSocket half proves the pattern and someone runs the actual hardware spike. Standing up IoT Core (custom authorizer, per-device policy, topic rules) speculatively — before anyone has confirmed `mqtt.js` even connects inside Vega's RN 0.83 fork — would be exactly the kind of unverified infra this repo's own testing philosophy argues against. `config.mqttWssUrl` is simply absent until that follow-up lands, and `createDeviceChannel()` goes straight to WebSocket when it's absent. **Write this as a FRICTION.md entry when you start Task 6** (the plan doesn't duplicate that content here — six fields, per `AGENTS.md`).
3. **Pairing's household identity is simplified.** §4.2 step 2 says "Sarah authenticates on her own device" — no Amazon-login integration exists anywhere in this repo, and building one is out of scope for S1. `POST /pair/claim` takes `householdId` directly, matching how `environment = dev | home` already models "there is exactly one real household" (§13.3). A consumer-facing version would put real auth in front of this endpoint; say so in the PR description.
4. **Cross-process handoff is a persisted queue, not shared memory.** `manifest.toml` puts the card service and the main UI in separate process groups specifically so a UI crash can't drop the channel — they cannot share a JS heap. `QueueStore` (Task 4) is the only channel between them, in both directions: inbound cards land in `/wick/queue.json`, outbound device events (card actions) land in `/wick/outbox.json` for the service to flush. The UI polls the queue every 1s while foregrounded; this is separate from, and does not affect, the 3s glass-to-glass budget for the card's *arrival*, which is dominated by the network hop, not the poll.

---

### Task 1: `DeviceWireMessage` contract + `MqttChannel`

**Files:**
- Modify: `packages/contracts/src/device.ts`
- Create: `apps/tv-vega/src/transport/MqttChannel.ts`
- Test: `apps/tv-vega/src/transport/__tests__/MqttChannel.test.ts`
- Modify: `apps/tv-vega/package.json` (add `mqtt` dependency)
- Modify: `eslint.config.js` (add `MqttChannel.ts` to the INV-2 ignore list)

**Interfaces:**
- Produces: `DeviceWireMessage` (from `@wick/contracts`) — `{ kind: 'card'; card: QueuedCard } | { kind: 'control'; control: ControlMessage }`, the envelope both transports use over the wire.
- Produces: `MqttChannel` class implementing `DeviceChannel` (from `@wick/contracts`), constructor `(config: MqttChannelConfig, connect?: MqttConnector)`.
- Produces: `MqttChannelConfig = { wssUrl: string; connectTimeoutMs?: number }`.
- Produces: `MqttConnector = (url: string, options: Record<string, unknown>) => MqttClient` (from `mqtt`), defaults to `mqtt.connect`.

- [ ] **Step 1: Add `DeviceWireMessage` to contracts**

Append to `packages/contracts/src/device.ts`, after the `DeviceChannel` interface:

```ts
/**
 * The wire envelope both transports use to distinguish a pushed card from a
 * control message. MQTT keeps these on separate topics and doesn't need the
 * envelope internally, but WebSocketChannel does — defined once here so
 * device and backend never drift.
 */
export type DeviceWireMessage =
  | { readonly kind: 'card'; readonly card: QueuedCard }
  | { readonly kind: 'control'; readonly control: ControlMessage };
```

Add `QueuedCard` to the existing `import type { QueuedCard, CardPatch } from './card.js';` — it's already imported for other uses in this file, so no import line changes needed beyond confirming it's there.

- [ ] **Step 2: Write the failing test for `MqttChannel`**

Create `apps/tv-vega/src/transport/__tests__/MqttChannel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { MqttChannel, type MqttConnector } from '../MqttChannel.js';

const TOKEN: DeviceToken = {
  jwt: 'jwt.token.here',
  deviceId: 'dev-1',
  householdId: 'hh-1',
  expiresAt: Date.now() + 1000,
};

class FakeMqttClient extends EventEmitter {
  published: Array<{ topic: string; payload: string }> = [];
  subscribed: string[] = [];
  ended = false;

  subscribe(topics: string[], _opts: unknown, cb: (err?: Error) => void): void {
    this.subscribed.push(...topics);
    cb();
  }

  publish(topic: string, payload: string, _opts: unknown, cb: (err?: Error) => void): void {
    this.published.push({ topic, payload });
    cb();
  }

  end(_force?: boolean): void {
    this.ended = true;
  }
}

function fakeConnector(client: FakeMqttClient): MqttConnector {
  return () => client as unknown as ReturnType<MqttConnector>;
}

describe('MqttChannel', () => {
  it('connects, subscribes to card and control topics, and resolves', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: 'wss://iot.example/mqtt' }, fakeConnector(client));

    const connecting = channel.connect(TOKEN);
    client.emit('connect');
    await connecting;

    expect(channel.state).toBe('open');
    expect(client.subscribed).toEqual(['wick/device/dev-1/cards', 'wick/device/dev-1/control']);
  });

  it('delivers a card message to onCard handlers', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: 'wss://iot.example/mqtt' }, fakeConnector(client));
    const connecting = channel.connect(TOKEN);
    client.emit('connect');
    await connecting;

    const card: QueuedCard = {
      id: 'c1',
      urgency: 'DOOR',
      card: { type: 'DOOR', id: 'c1', householdId: 'hh-1', correlationId: 'x', createdAt: 0, actions: [], line: 'hi' },
      queuedAt: 0,
      shownCount: 0,
    };
    const received: QueuedCard[] = [];
    channel.onCard((c) => received.push(c));
    client.emit('message', 'wick/device/dev-1/cards', Buffer.from(JSON.stringify(card)));

    expect(received).toEqual([card]);
  });

  it('publishes a DeviceEvent to the events topic', async () => {
    const client = new FakeMqttClient();
    const channel = new MqttChannel({ wssUrl: 'wss://iot.example/mqtt' }, fakeConnector(client));
    const connecting = channel.connect(TOKEN);
    client.emit('connect');
    await connecting;

    await channel.send({ t: 'card_shown', cardId: 'c1', at: 1 });

    expect(client.published).toEqual([
      { topic: 'wick/device/dev-1/events', payload: JSON.stringify({ t: 'card_shown', cardId: 'c1', at: 1 }) },
    ]);
  });

  it('rejects if the connector never emits connect within the timeout', async () => {
    vi.useFakeTimers();
    const client = new FakeMqttClient();
    const channel = new MqttChannel(
      { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 50 },
      fakeConnector(client),
    );

    const connecting = channel.connect(TOKEN);
    const assertion = expect(connecting).rejects.toThrow('mqtt_connect_timeout');
    await vi.advanceTimersByTimeAsync(60);
    await assertion;
    expect(client.ended).toBe(true);
    vi.useRealTimers();
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/transport/__tests__/MqttChannel.test.ts`
Expected: FAIL — `../MqttChannel.js` has no exported member `MqttChannel` (module doesn't exist yet).

- [ ] **Step 4: Add the `mqtt` dependency**

In `apps/tv-vega/package.json`, add to `"dependencies"`:

```json
"mqtt": "^5.10.0",
```

Run: `npm install` (from repo root — the workspace installs it for `apps/tv-vega`).

- [ ] **Step 5: Implement `MqttChannel`**

Create `apps/tv-vega/src/transport/MqttChannel.ts`:

```ts
/**
 * Option A — AWS IoT Core, MQTT over WSS.
 *
 * Wraps `mqtt.connect()`. Per-device topics keep an IoT policy scoped to
 * exactly what one device needs:
 *   wick/device/<id>/cards    — QueuedCard, QoS 1
 *   wick/device/<id>/control  — ControlMessage, QoS 1
 *   wick/device/<id>/events   — DeviceEvent, published by the device
 *
 * QoS 1 + a persistent session (`clean: false`) is the whole reason to prefer
 * this over WebSocketChannel: a card queued while the TV was off arrives on
 * reconnect without any application-level catch-up logic.
 *
 * SP-5 (docs/WICK-TECHNICAL.md §14): unproven inside Vega's RN 0.83 fork until
 * this runs on real hardware. createDeviceChannel.ts times this out and falls
 * back to WebSocketChannel — see FRICTION.md and the plan's Scope decisions.
 */
import mqttLib, { type MqttClient } from 'mqtt';
import type {
  ChannelState,
  ControlMessage,
  DeviceChannel,
  DeviceEvent,
  DeviceToken,
  QueuedCard,
  Unsubscribe,
} from '@wick/contracts';

export type MqttConnector = (url: string, options: Record<string, unknown>) => MqttClient;

export interface MqttChannelConfig {
  readonly wssUrl: string;
  readonly connectTimeoutMs?: number;
}

interface Topics {
  readonly cards: string;
  readonly control: string;
  readonly events: string;
}

const topicsFor = (deviceId: string): Topics => ({
  cards: `wick/device/${deviceId}/cards`,
  control: `wick/device/${deviceId}/control`,
  events: `wick/device/${deviceId}/events`,
});

const DEFAULT_CONNECT_TIMEOUT_MS = 4000;

export class MqttChannel implements DeviceChannel {
  readonly #config: MqttChannelConfig;
  readonly #connect: MqttConnector;
  #client: MqttClient | undefined;
  #topics: Topics | undefined;
  #state: ChannelState = 'closed';
  readonly #cardHandlers = new Set<(c: QueuedCard) => void>();
  readonly #controlHandlers = new Set<(m: ControlMessage) => void>();

  constructor(config: MqttChannelConfig, connect: MqttConnector = mqttLib.connect) {
    this.#config = config;
    this.#connect = connect;
  }

  get state(): ChannelState {
    return this.#state;
  }

  connect(token: DeviceToken): Promise<void> {
    const topics = topicsFor(token.deviceId);
    this.#topics = topics;
    this.#state = 'connecting';

    return new Promise((resolve, reject) => {
      let settled = false;
      const client = this.#connect(this.#config.wssUrl, {
        username: token.deviceId,
        password: token.jwt,
        clientId: token.deviceId,
        clean: false,
        reconnectPeriod: 0, // WebSocketChannel-style backoff is owned by createDeviceChannel's caller, not here
      });
      this.#client = client;

      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        this.#state = 'closed';
        client.end(true);
        reject(new Error('mqtt_connect_timeout'));
      }, this.#config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS);

      client.on('connect', () => {
        this.#state = 'open';
        client.subscribe([topics.cards, topics.control], { qos: 1 }, (err) => {
          if (settled) return;
          settled = true;
          clearTimeout(timeout);
          if (err) reject(err);
          else resolve();
        });
      });

      client.on('message', (topic: string, payload: Buffer) => {
        if (topic === topics.cards) {
          const card = JSON.parse(payload.toString('utf8')) as QueuedCard;
          for (const h of this.#cardHandlers) h(card);
        } else if (topic === topics.control) {
          const control = JSON.parse(payload.toString('utf8')) as ControlMessage;
          for (const h of this.#controlHandlers) h(control);
        }
      });

      client.on('close', () => {
        this.#state = 'closed';
      });

      client.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  onCard(handler: (c: QueuedCard) => void): Unsubscribe {
    this.#cardHandlers.add(handler);
    return () => this.#cardHandlers.delete(handler);
  }

  onControl(handler: (m: ControlMessage) => void): Unsubscribe {
    this.#controlHandlers.add(handler);
    return () => this.#controlHandlers.delete(handler);
  }

  async send(e: DeviceEvent): Promise<void> {
    const client = this.#client;
    const topics = this.#topics;
    if (!client || !topics) throw new Error('not_connected');
    await new Promise<void>((resolve, reject) => {
      client.publish(topics.events, JSON.stringify(e), { qos: 1 }, (err?: Error) =>
        err ? reject(err) : resolve(),
      );
    });
  }
}
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/transport/__tests__/MqttChannel.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: Add the INV-2 eslint exemption**

In `eslint.config.js`, change:

```js
ignores: ['services/agent/src/egress.ts', '**/__tests__/**'],
```

to:

```js
ignores: [
  'services/agent/src/egress.ts',
  'apps/tv-vega/src/transport/MqttChannel.ts',
  'apps/tv-vega/src/transport/WebSocketChannel.ts',
  'apps/tv-vega/src/transport/createDeviceChannel.ts',
  '**/__tests__/**',
],
```

(The last two entries are for Tasks 2 and 3 — add them all now so this file only changes once.)

- [ ] **Step 8: Run lint to confirm no violation**

Run: `npx eslint apps/tv-vega/src/transport/MqttChannel.ts`
Expected: no errors.

- [ ] **Step 9: Commit**

```bash
git add packages/contracts/src/device.ts apps/tv-vega/src/transport/MqttChannel.ts \
  apps/tv-vega/src/transport/__tests__/MqttChannel.test.ts apps/tv-vega/package.json \
  package-lock.json eslint.config.js
git commit -m "feat(vega): implement MqttChannel (SP-5 option A) and DeviceWireMessage contract"
```

---

### Task 2: `WebSocketChannel`

**Files:**
- Create: `apps/tv-vega/src/transport/WebSocketChannel.ts`
- Test: `apps/tv-vega/src/transport/__tests__/WebSocketChannel.test.ts`

**Interfaces:**
- Consumes: `DeviceChannel`, `DeviceWireMessage`, `DeviceToken`, `QueuedCard`, `ControlMessage`, `DeviceEvent` from `@wick/contracts` (Task 1).
- Produces: `WebSocketChannel` class implementing `DeviceChannel`, constructor `(config: WebSocketChannelConfig, open?: WebSocketFactory)`, plus a `close(): void` method (not part of `DeviceChannel`, used by `CardService.onStop`).
- Produces: `WebSocketChannelConfig = { url: string; getLastSeenCardId?: () => string | undefined | Promise<string | undefined> }`.
- Produces: `WebSocketFactory = (url: string) => WebSocket`.

- [ ] **Step 1: Write the failing test**

Create `apps/tv-vega/src/transport/__tests__/WebSocketChannel.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DeviceToken, QueuedCard } from '@wick/contracts';
import { WebSocketChannel, type WebSocketFactory } from '../WebSocketChannel.js';

const TOKEN: DeviceToken = {
  jwt: 'jwt.token.here',
  deviceId: 'dev-1',
  householdId: 'hh-1',
  expiresAt: Date.now() + 1000,
};

class FakeSocket {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.onclose?.();
  }
}

function fakeFactory(): WebSocketFactory {
  return (url: string) => new FakeSocket(url) as unknown as WebSocket;
}

describe('WebSocketChannel', () => {
  it('connects, sends reconcile on open, and resolves', async () => {
    FakeSocket.instances = [];
    const channel = new WebSocketChannel(
      { url: 'wss://api.example/prod', getLastSeenCardId: () => 'c9' },
      fakeFactory(),
    );

    const connecting = channel.connect(TOKEN);
    const socket = FakeSocket.instances[0]!;
    expect(socket.url).toBe('wss://api.example/prod?token=jwt.token.here');
    socket.onopen?.();
    await connecting;

    expect(channel.state).toBe('open');
    expect(socket.sent).toEqual([JSON.stringify({ t: 'reconcile', sinceCardId: 'c9' })]);
  });

  it('delivers a card wire message to onCard handlers', async () => {
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    await connecting;

    const card: QueuedCard = {
      id: 'c1',
      urgency: 'DOOR',
      card: { type: 'DOOR', id: 'c1', householdId: 'hh-1', correlationId: 'x', createdAt: 0, actions: [], line: 'hi' },
      queuedAt: 0,
      shownCount: 0,
    };
    const received: QueuedCard[] = [];
    channel.onCard((c) => received.push(c));
    socket.onmessage?.({ data: JSON.stringify({ kind: 'card', card }) });

    expect(received).toEqual([card]);
  });

  it('sends a DeviceEvent as raw JSON', async () => {
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    const socket = FakeSocket.instances[0]!;
    socket.onopen?.();
    await connecting;

    await channel.send({ t: 'card_shown', cardId: 'c1', at: 1 });

    expect(socket.sent.at(-1)).toBe(JSON.stringify({ t: 'card_shown', cardId: 'c1', at: 1 }));
  });

  it('reconnects with full-jitter backoff after an unexpected close', async () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    FakeSocket.instances[0]!.onopen?.();
    await connecting;

    FakeSocket.instances[0]!.onclose?.();
    expect(channel.state).toBe('backoff');

    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeSocket.instances.length).toBe(2);

    vi.useRealTimers();
  });

  it('does not reconnect after an intentional close()', async () => {
    vi.useFakeTimers();
    FakeSocket.instances = [];
    const channel = new WebSocketChannel({ url: 'wss://api.example/prod' }, fakeFactory());
    const connecting = channel.connect(TOKEN);
    FakeSocket.instances[0]!.onopen?.();
    await connecting;

    channel.close();
    expect(channel.state).toBe('closed');

    await vi.advanceTimersByTimeAsync(5000);
    expect(FakeSocket.instances.length).toBe(1);

    vi.useRealTimers();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/transport/__tests__/WebSocketChannel.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `WebSocketChannel`**

Create `apps/tv-vega/src/transport/WebSocketChannel.ts`:

```ts
/**
 * Option B — API Gateway WebSocket. Zero library risk: RN ships a standard
 * WebSocket. Auth travels in the connect URL's query string (`?token=`)
 * because RN's WebSocket cannot set arbitrary connect-time headers.
 *
 * Reconnect: exponential backoff 1s -> 30s, full jitter. On open, always
 * reconcile: send lastSeenCardId, receive everything after it.
 */
import type {
  ChannelState,
  ControlMessage,
  DeviceChannel,
  DeviceEvent,
  DeviceToken,
  DeviceWireMessage,
  QueuedCard,
  Unsubscribe,
} from '@wick/contracts';

export type WebSocketFactory = (url: string) => WebSocket;

export interface WebSocketChannelConfig {
  readonly url: string;
  readonly getLastSeenCardId?: () => string | undefined | Promise<string | undefined>;
}

const MIN_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

export class WebSocketChannel implements DeviceChannel {
  readonly #config: WebSocketChannelConfig;
  readonly #open: WebSocketFactory;
  #socket: WebSocket | undefined;
  #state: ChannelState = 'closed';
  #token: DeviceToken | undefined;
  readonly #cardHandlers = new Set<(c: QueuedCard) => void>();
  readonly #controlHandlers = new Set<(m: ControlMessage) => void>();
  #backoffMs = MIN_BACKOFF_MS;
  #reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  #closing = false;

  constructor(config: WebSocketChannelConfig, open: WebSocketFactory = (url) => new WebSocket(url)) {
    this.#config = config;
    this.#open = open;
  }

  get state(): ChannelState {
    return this.#state;
  }

  connect(token: DeviceToken): Promise<void> {
    this.#token = token;
    this.#closing = false;
    this.#backoffMs = MIN_BACKOFF_MS;
    return this.#openSocket();
  }

  close(): void {
    this.#closing = true;
    clearTimeout(this.#reconnectTimer);
    this.#socket?.close();
    this.#state = 'closed';
  }

  onCard(handler: (c: QueuedCard) => void): Unsubscribe {
    this.#cardHandlers.add(handler);
    return () => this.#cardHandlers.delete(handler);
  }

  onControl(handler: (m: ControlMessage) => void): Unsubscribe {
    this.#controlHandlers.add(handler);
    return () => this.#controlHandlers.delete(handler);
  }

  async send(e: DeviceEvent): Promise<void> {
    if (!this.#socket || this.#state !== 'open') throw new Error('not_connected');
    this.#socket.send(JSON.stringify(e));
  }

  #openSocket(): Promise<void> {
    this.#state = 'connecting';
    const token = this.#token!;
    const url = `${this.#config.url}?token=${encodeURIComponent(token.jwt)}`;

    return new Promise((resolve, reject) => {
      const socket = this.#open(url);
      this.#socket = socket;
      let settled = false;

      socket.onopen = () => {
        void (async () => {
          this.#state = 'open';
          this.#backoffMs = MIN_BACKOFF_MS;
          const sinceCardId = await this.#config.getLastSeenCardId?.();
          socket.send(JSON.stringify({ t: 'reconcile', sinceCardId }));
          if (!settled) {
            settled = true;
            resolve();
          }
        })();
      };

      socket.onmessage = (ev: { data: unknown }) => {
        const msg = JSON.parse(String(ev.data)) as DeviceWireMessage;
        if (msg.kind === 'card') {
          for (const h of this.#cardHandlers) h(msg.card);
        } else {
          for (const h of this.#controlHandlers) h(msg.control);
        }
      };

      socket.onclose = () => {
        this.#state = this.#closing ? 'closed' : 'backoff';
        if (!settled) {
          settled = true;
          reject(new Error('websocket_closed_before_open'));
        }
        if (!this.#closing) this.#scheduleReconnect();
      };

      socket.onerror = () => {
        // onclose always follows onerror on both RN and browser WebSocket.
      };
    });
  }

  #scheduleReconnect(): void {
    const delay = Math.random() * this.#backoffMs; // full jitter: uniform(0, current backoff)
    this.#backoffMs = Math.min(this.#backoffMs * 2, MAX_BACKOFF_MS);
    this.#reconnectTimer = setTimeout(() => void this.#openSocket(), delay);
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/transport/__tests__/WebSocketChannel.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add apps/tv-vega/src/transport/WebSocketChannel.ts apps/tv-vega/src/transport/__tests__/WebSocketChannel.test.ts
git commit -m "feat(vega): implement WebSocketChannel (SP-5 option B) with jittered reconnect"
```

---

### Task 3: `createDeviceChannel` factory

**Files:**
- Create: `apps/tv-vega/src/transport/createDeviceChannel.ts`
- Modify: `apps/tv-vega/src/transport/index.ts` (export the factory alongside the existing type re-exports)
- Test: `apps/tv-vega/src/transport/__tests__/createDeviceChannel.test.ts`

**Interfaces:**
- Consumes: `MqttChannel` (Task 1), `WebSocketChannel` (Task 2), `DeviceChannel`/`DeviceToken` from `@wick/contracts`.
- Produces: `createDeviceChannel(config: DeviceChannelConfig, token: DeviceToken): Promise<DeviceChannel>`, `DeviceChannelConfig = { mqtt?: MqttChannelConfig; websocket: WebSocketChannelConfig }`. Consumed by `CardService` (Task 9).

- [ ] **Step 1: Write the failing test**

Create `apps/tv-vega/src/transport/__tests__/createDeviceChannel.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { createDeviceChannel } from '../createDeviceChannel.js';
import { MqttChannel } from '../MqttChannel.js';
import { WebSocketChannel } from '../WebSocketChannel.js';

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 1000 };

describe('createDeviceChannel', () => {
  it('returns an MqttChannel when config.mqtt is present and it connects', async () => {
    const okConnector = (): ReturnType<typeof mqttStub> => mqttStub(true);
    function mqttStub(connects: boolean) {
      const { EventEmitter } = require('node:events') as typeof import('node:events');
      const client = new EventEmitter() as EventEmitter & {
        subscribe: (t: string[], o: unknown, cb: (e?: Error) => void) => void;
        publish: (t: string, p: string, o: unknown, cb: (e?: Error) => void) => void;
        end: () => void;
      };
      client.subscribe = (_t, _o, cb) => cb();
      client.publish = (_t, _p, _o, cb) => cb();
      client.end = () => undefined;
      if (connects) queueMicrotask(() => client.emit('connect'));
      return client;
    }

    const channel = await createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 50 }, websocket: { url: 'wss://ws.example' } },
      TOKEN,
    );

    expect(channel).toBeInstanceOf(MqttChannel);
  });

  it('falls back to WebSocketChannel when MQTT fails to connect', async () => {
    const brokenConnector = () => {
      const { EventEmitter } = require('node:events') as typeof import('node:events');
      return new EventEmitter() as unknown as ReturnType<typeof brokenConnector>; // never emits 'connect' -> times out
    };
    const wsFactory = () => {
      const socket = {
        onopen: null as (() => void) | null,
        onmessage: null,
        onclose: null,
        onerror: null,
        send: () => undefined,
        close: () => undefined,
      };
      queueMicrotask(() => socket.onopen?.());
      return socket as unknown as WebSocket;
    };

    const channel = await createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 20 }, websocket: { url: 'wss://ws.example' } },
      TOKEN,
    );
    // This first call exercises the real mqtt.connect path (module not mocked) via
    // the config-less overload below instead — see the next test for the
    // deterministic fallback path using injected factories.
    void channel;
  });

  it('goes straight to WebSocketChannel when config.mqtt is absent', async () => {
    const channel = await createDeviceChannel({ websocket: { url: 'wss://ws.example' } }, TOKEN);
    expect(channel).toBeInstanceOf(WebSocketChannel);
  });
});
```

The second test as drafted can't inject a broken MQTT connector without `createDeviceChannel` accepting connector overrides, which would leak test seams into production code. Replace it with a cleaner version once Step 3's implementation is in place — see Step 2.

- [ ] **Step 2: Replace the test with the DI-friendly version**

`createDeviceChannel` takes optional connector/factory overrides purely for testability, mirroring how `MqttChannel`/`WebSocketChannel` already accept them. Rewrite the whole test file:

```ts
import { describe, expect, it } from 'vitest';
import { EventEmitter } from 'node:events';
import type { DeviceToken } from '@wick/contracts';
import { createDeviceChannel } from '../createDeviceChannel.js';
import { MqttChannel, type MqttConnector } from '../MqttChannel.js';
import { WebSocketChannel, type WebSocketFactory } from '../WebSocketChannel.js';

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 1000 };

function workingMqttConnector(): MqttConnector {
  return () => {
    const client = Object.assign(new EventEmitter(), {
      subscribe: (_t: string[], _o: unknown, cb: (e?: Error) => void) => cb(),
      publish: (_t: string, _p: string, _o: unknown, cb: (e?: Error) => void) => cb(),
      end: () => undefined,
    });
    queueMicrotask(() => client.emit('connect'));
    return client as unknown as ReturnType<MqttConnector>;
  };
}

function brokenMqttConnector(): MqttConnector {
  return () => new EventEmitter() as unknown as ReturnType<MqttConnector>; // never emits 'connect' -> times out
}

function workingWsFactory(): WebSocketFactory {
  return (url: string) => {
    const socket = {
      url,
      onopen: null as (() => void) | null,
      onmessage: null,
      onclose: null,
      onerror: null,
      send: () => undefined,
      close: () => undefined,
    };
    queueMicrotask(() => socket.onopen?.());
    return socket as unknown as WebSocket;
  };
}

describe('createDeviceChannel', () => {
  it('returns MqttChannel when MQTT connects', async () => {
    const channel = await createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt' }, websocket: { url: 'wss://ws.example' } },
      TOKEN,
      { mqttConnect: workingMqttConnector(), websocketOpen: workingWsFactory() },
    );
    expect(channel).toBeInstanceOf(MqttChannel);
  });

  it('falls back to WebSocketChannel when MQTT times out', async () => {
    const channel = await createDeviceChannel(
      { mqtt: { wssUrl: 'wss://iot.example/mqtt', connectTimeoutMs: 10 }, websocket: { url: 'wss://ws.example' } },
      TOKEN,
      { mqttConnect: brokenMqttConnector(), websocketOpen: workingWsFactory() },
    );
    expect(channel).toBeInstanceOf(WebSocketChannel);
  });

  it('goes straight to WebSocketChannel when config.mqtt is absent', async () => {
    const channel = await createDeviceChannel(
      { websocket: { url: 'wss://ws.example' } },
      TOKEN,
      { websocketOpen: workingWsFactory() },
    );
    expect(channel).toBeInstanceOf(WebSocketChannel);
  });
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/transport/__tests__/createDeviceChannel.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement `createDeviceChannel`**

Create `apps/tv-vega/src/transport/createDeviceChannel.ts`:

```ts
/**
 * SP-5 resolved as runtime behaviour rather than a static choice: no Vega
 * hardware was available to run the documented 4-hour spike
 * (docs/WICK-TECHNICAL.md §14 SP-5), so both implementations ship and this
 * factory tries IoT Core MQTT first, falling back to the WebSocket API on any
 * connect failure or timeout — every time the app starts, not just once. See
 * the plan's Scope decisions and FRICTION.md for why IoT Core infra isn't
 * live yet.
 */
import type { DeviceChannel, DeviceToken } from '@wick/contracts';
import { MqttChannel, type MqttChannelConfig, type MqttConnector } from './MqttChannel.js';
import { WebSocketChannel, type WebSocketChannelConfig, type WebSocketFactory } from './WebSocketChannel.js';

export interface DeviceChannelConfig {
  /** Absent until infra/transport.tf's IoT Core stack is deployed. */
  readonly mqtt?: MqttChannelConfig;
  readonly websocket: WebSocketChannelConfig;
}

export interface DeviceChannelOverrides {
  readonly mqttConnect?: MqttConnector;
  readonly websocketOpen?: WebSocketFactory;
}

export async function createDeviceChannel(
  config: DeviceChannelConfig,
  token: DeviceToken,
  overrides: DeviceChannelOverrides = {},
): Promise<DeviceChannel> {
  if (config.mqtt) {
    const mqttChannel = overrides.mqttConnect
      ? new MqttChannel(config.mqtt, overrides.mqttConnect)
      : new MqttChannel(config.mqtt);
    try {
      await mqttChannel.connect(token);
      return mqttChannel;
    } catch {
      // Falls through to B. The first time this actually fires on hardware is
      // a FRICTION.md entry, not a silent path — see docs/WICK-TECHNICAL.md §14.
    }
  }
  const wsChannel = overrides.websocketOpen
    ? new WebSocketChannel(config.websocket, overrides.websocketOpen)
    : new WebSocketChannel(config.websocket);
  await wsChannel.connect(token);
  return wsChannel;
}
```

- [ ] **Step 5: Update the transport barrel export**

Modify `apps/tv-vega/src/transport/index.ts` — replace its entire contents:

```ts
/**
 * Re-exports the transport contract from @wick/contracts, plus the one
 * factory that is allowed to pick between the two concrete implementations.
 * See docs/WICK-TECHNICAL.md §4.1 and the plan's Scope decisions for why both
 * exist and how the choice is made at runtime rather than build time.
 */
export type { DeviceChannel, ChannelState, Unsubscribe } from '@wick/contracts';
export { createDeviceChannel, type DeviceChannelConfig } from './createDeviceChannel.js';
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/transport/__tests__/createDeviceChannel.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: Run lint on the whole transport directory**

Run: `npx eslint apps/tv-vega/src/transport/`
Expected: no errors (all three concrete-import files are now in the ignore list from Task 1 Step 7).

- [ ] **Step 8: Commit**

```bash
git add apps/tv-vega/src/transport/createDeviceChannel.ts apps/tv-vega/src/transport/index.ts \
  apps/tv-vega/src/transport/__tests__/createDeviceChannel.test.ts
git commit -m "feat(vega): createDeviceChannel — MQTT-first with WebSocket fallback"
```

---

### Task 4: `config.ts` + `QueueStore`

**Files:**
- Create: `apps/tv-vega/src/config.ts`
- Test: `apps/tv-vega/src/__tests__/config.test.ts`
- Create: `apps/tv-vega/src/headless/QueueStore.ts`
- Test: `apps/tv-vega/src/headless/__tests__/QueueStore.test.ts`
- Modify: `apps/tv-vega/tsconfig.json` (not needed — no JSON import used; skip)

**Interfaces:**
- Produces: `DeviceConfig`, `loadDeviceConfig(): DeviceConfig`, `resolveDeviceConfig(partial: Partial<DeviceConfig>): DeviceConfig` (the last is what's actually unit tested).
- Produces: `FileSystemLike` (structural type matching `@amazon-devices/kepler-file-system`'s default export — `readFileAsString`, `writeStringToFile`, `exists`), `QueueStore` class with `readAll`, `upsert`, `applyPatch`, `remove`, `lastSeenCardId`, `enqueueOutbound`, `drainOutbound`.
- Consumed by: `PairingFlow` (Task 5, imports `FileSystemLike`), `CardService` (Task 9), `App.tsx` (Task 10).

- [ ] **Step 1: Write the failing test for `config.ts`**

Create `apps/tv-vega/src/__tests__/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { resolveDeviceConfig } from '../config.js';

describe('resolveDeviceConfig', () => {
  it('throws when pairingApiUrl or websocketUrl is missing', () => {
    expect(() => resolveDeviceConfig({})).toThrow(/not populated/);
    expect(() => resolveDeviceConfig({ pairingApiUrl: 'https://a' })).toThrow(/not populated/);
  });

  it('returns the config when both required fields are present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
    });
    expect(config).toEqual({ pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example/prod' });
  });

  it('carries mqttWssUrl through only when present', () => {
    const config = resolveDeviceConfig({
      pairingApiUrl: 'https://pair.example',
      websocketUrl: 'wss://ws.example/prod',
      mqttWssUrl: 'wss://iot.example/mqtt',
    });
    expect(config.mqttWssUrl).toBe('wss://iot.example/mqtt');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/__tests__/config.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement `config.ts`**

Create `apps/tv-vega/src/config.ts`:

```ts
/**
 * Deployed endpoint configuration — the Vega equivalent of the "paste into
 * Ring console" fields in infra/outputs.tf. Populate DEPLOYED after
 * `terraform apply` against infra/pairing.tf and infra/transport.tf. There is
 * no default: a device silently pointed at nothing is worse than one that
 * fails to boot with a clear message.
 */
export interface DeviceConfig {
  readonly pairingApiUrl: string;
  readonly websocketUrl: string;
  /** Absent until infra/transport.tf's IoT Core stack exists — SP-5, see FRICTION.md. */
  readonly mqttWssUrl?: string;
}

export function resolveDeviceConfig(partial: Partial<DeviceConfig>): DeviceConfig {
  const { pairingApiUrl, websocketUrl, mqttWssUrl } = partial;
  if (!pairingApiUrl || !websocketUrl) {
    throw new Error(
      'apps/tv-vega/src/config.ts is not populated. Run `terraform output` in infra/ ' +
        'after applying pairing.tf and transport.tf, and fill in DEPLOYED below.',
    );
  }
  return { pairingApiUrl, websocketUrl, ...(mqttWssUrl ? { mqttWssUrl } : {}) };
}

/**
 * Fill these in from `terraform output` once infra/pairing.tf and
 * infra/transport.tf are applied. Left blank deliberately — see the header
 * comment above.
 */
const DEPLOYED: Partial<DeviceConfig> = {
  // pairingApiUrl: 'https://xxxx.execute-api.us-east-1.amazonaws.com',
  // websocketUrl: 'wss://yyyy.execute-api.us-east-1.amazonaws.com/prod',
};

export function loadDeviceConfig(): DeviceConfig {
  return resolveDeviceConfig(DEPLOYED);
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/__tests__/config.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write the failing test for `QueueStore`**

Create `apps/tv-vega/src/headless/__tests__/QueueStore.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path);
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

const doorCard = (id: string): QueuedCard => ({
  id,
  urgency: 'DOOR',
  card: { type: 'DOOR', id, householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [], line: 'hi' },
  queuedAt: 0,
  shownCount: 0,
});

describe('QueueStore', () => {
  it('starts empty', async () => {
    const store = new QueueStore(fakeFs());
    expect(await store.readAll()).toEqual([]);
    expect(await store.lastSeenCardId()).toBeUndefined();
  });

  it('upserts by id without duplicating', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c1'));
    await store.upsert(doorCard('c2'));

    const all = await store.readAll();
    expect(all.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(await store.lastSeenCardId()).toBe('c2');
  });

  it('applies a Phase 2 patch to the matching DOOR card only', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.applyPatch({ cardId: 'c1', description: 'A courier in a blue jacket.' });

    const [card] = await store.readAll();
    expect(card!.card.type).toBe('DOOR');
    expect((card!.card as { description?: string }).description).toBe('A courier in a blue jacket.');
  });

  it('removes a card by id', async () => {
    const store = new QueueStore(fakeFs());
    await store.upsert(doorCard('c1'));
    await store.remove('c1');
    expect(await store.readAll()).toEqual([]);
  });

  it('queues and drains outbound device events', async () => {
    const store = new QueueStore(fakeFs());
    await store.enqueueOutbound({ t: 'card_shown', cardId: 'c1', at: 1 });
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'answer', at: 2 });

    const drained = await store.drainOutbound();
    expect(drained).toHaveLength(2);
    expect(await store.drainOutbound()).toEqual([]);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/headless/__tests__/QueueStore.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Implement `QueueStore`**

Create `apps/tv-vega/src/headless/QueueStore.ts`:

```ts
/**
 * The on-device card queue — the hand-off between the card service process
 * and the main UI process. manifest.toml puts them in separate process
 * groups precisely so a UI crash cannot drop the channel; they share no JS
 * memory, so this persisted file is the only channel between them, in both
 * directions: inbound cards (upsert/applyPatch/remove) and outbound device
 * events (enqueueOutbound/drainOutbound, flushed by CardService).
 *
 * Survives restart because it IS the restart state (§3.4 rule 4).
 */
import type { CardPatch, DeviceEvent, QueuedCard } from '@wick/contracts';

export interface FileSystemLike {
  readFileAsString(path: string, encoding: string): Promise<string>;
  writeStringToFile(path: string, content: string, encoding: string): Promise<number>;
  exists(path: string): Promise<boolean>;
}

const QUEUE_PATH = '/wick/queue.json';
const OUTBOX_PATH = '/wick/outbox.json';
const ENCODING = 'utf8';

export class QueueStore {
  readonly #fs: FileSystemLike;
  readonly #queuePath: string;
  readonly #outboxPath: string;

  constructor(fs: FileSystemLike, queuePath: string = QUEUE_PATH, outboxPath: string = OUTBOX_PATH) {
    this.#fs = fs;
    this.#queuePath = queuePath;
    this.#outboxPath = outboxPath;
  }

  async readAll(): Promise<readonly QueuedCard[]> {
    return this.#readJson<QueuedCard>(this.#queuePath);
  }

  /** Upsert by id — a Phase 2 patch replaces in place, it never duplicates. */
  async upsert(card: QueuedCard): Promise<void> {
    const all = await this.readAll();
    await this.#writeJson(this.#queuePath, [...all.filter((c) => c.id !== card.id), card]);
  }

  async applyPatch(patch: CardPatch): Promise<void> {
    const all = await this.readAll();
    const next = all.map((q) => {
      if (q.id !== patch.cardId || q.card.type !== 'DOOR') return q;
      return {
        ...q,
        card: {
          ...q.card,
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.imageRef === undefined ? {} : { imageRef: patch.imageRef }),
          ...(patch.match === undefined ? {} : { match: patch.match }),
        },
      };
    });
    await this.#writeJson(this.#queuePath, next);
  }

  async remove(cardId: string): Promise<void> {
    const all = await this.readAll();
    await this.#writeJson(this.#queuePath, all.filter((c) => c.id !== cardId));
  }

  async lastSeenCardId(): Promise<string | undefined> {
    const all = await this.readAll();
    return all.at(-1)?.id;
  }

  async enqueueOutbound(event: DeviceEvent): Promise<void> {
    const all = await this.#readJson<DeviceEvent>(this.#outboxPath);
    await this.#writeJson(this.#outboxPath, [...all, event]);
  }

  async drainOutbound(): Promise<readonly DeviceEvent[]> {
    const all = await this.#readJson<DeviceEvent>(this.#outboxPath);
    await this.#writeJson(this.#outboxPath, []);
    return all;
  }

  async #readJson<T>(path: string): Promise<readonly T[]> {
    if (!(await this.#fs.exists(path))) return [];
    const raw = await this.#fs.readFileAsString(path, ENCODING);
    return raw ? (JSON.parse(raw) as readonly T[]) : [];
  }

  #writeJson<T>(path: string, value: readonly T[]): Promise<number> {
    return this.#fs.writeStringToFile(path, JSON.stringify(value), ENCODING);
  }
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/headless/__tests__/QueueStore.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 9: Commit**

```bash
git add apps/tv-vega/src/config.ts apps/tv-vega/src/__tests__/config.test.ts \
  apps/tv-vega/src/headless/QueueStore.ts apps/tv-vega/src/headless/__tests__/QueueStore.test.ts
git commit -m "feat(vega): device config resolver and cross-process QueueStore"
```

---

### Task 5: `PairingFlow` (device side)

**Files:**
- Modify: `apps/tv-vega/src/pairing/PairingFlow.ts`
- Modify: `apps/tv-vega/src/pairing/index.ts`
- Test: `apps/tv-vega/src/pairing/__tests__/PairingFlow.test.ts`

**Interfaces:**
- Consumes: `FileSystemLike` from `../headless/QueueStore.js` (Task 4), `DeviceToken` from `@wick/contracts`.
- Produces: `PairingFlow` class — `loadToken()`, `clearToken()`, `start(deviceId)`, `pollUntilBound(code)`; `PairingStartResponse`, `PairingStatusResponse` types. Consumed by `CardService` and `App.tsx` (Tasks 9–10).

- [ ] **Step 1: Write the failing test**

Create `apps/tv-vega/src/pairing/__tests__/PairingFlow.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { DeviceToken } from '@wick/contracts';
import { PairingFlow } from '../PairingFlow.js';
import type { FileSystemLike } from '../../headless/QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path) && files.get(path) !== '';
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

const TOKEN: DeviceToken = { jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 };

describe('PairingFlow', () => {
  it('loadToken returns null when nothing is stored', async () => {
    const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs());
    expect(await flow.loadToken()).toBeNull();
  });

  it('start() posts deviceId and returns the pairing code', async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ code: '123456', url: 'https://pair.example/123456', expiresAt: 1 }), {
        status: 200,
      }),
    );
    const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fakeFs(), fetchMock as unknown as typeof fetch);

    const result = await flow.start('d1');

    expect(result.code).toBe('123456');
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pair.example/pair/start',
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('pollUntilBound polls until bound, then persists the token', async () => {
    let call = 0;
    const fetchMock = vi.fn(async () => {
      call += 1;
      const body = call < 3 ? { status: 'pending' } : { status: 'bound', token: TOKEN };
      return new Response(JSON.stringify(body), { status: 200 });
    });
    const fs = fakeFs();
    const flow = new PairingFlow(
      { pairingApiUrl: 'https://pair.example', pollIntervalMs: 1, pollTimeoutMs: 1000 },
      fs,
      fetchMock as unknown as typeof fetch,
    );

    const token = await flow.pollUntilBound('123456');

    expect(token).toEqual(TOKEN);
    expect(await flow.loadToken()).toEqual(TOKEN);
  });

  it('pollUntilBound throws when the code expires (404)', async () => {
    const fetchMock = vi.fn(async () => new Response('gone', { status: 404 }));
    const flow = new PairingFlow(
      { pairingApiUrl: 'https://pair.example', pollIntervalMs: 1 },
      fakeFs(),
      fetchMock as unknown as typeof fetch,
    );

    await expect(flow.pollUntilBound('123456')).rejects.toThrow('pairing_code_expired');
  });

  it('clearToken removes a stored token', async () => {
    const fs = fakeFs();
    const flow = new PairingFlow({ pairingApiUrl: 'https://pair.example' }, fs);
    await fs.writeStringToFile('/wick/token.json', JSON.stringify(TOKEN), 'utf8');

    await flow.clearToken();

    expect(await flow.loadToken()).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/pairing/__tests__/PairingFlow.test.ts`
Expected: FAIL — `PairingFlow` throws `not implemented` / no such export.

- [ ] **Step 3: Implement `PairingFlow`**

Replace `apps/tv-vega/src/pairing/PairingFlow.ts` entirely:

```ts
/**
 * Six-digit pairing. The television never sees an account password.
 *
 * INV-1: the device ends up holding exactly one device-bound JWT, scoped to
 * receiving cards for one household and posting playback events. Assume it is
 * extractable — Vega documents no hardware-backed keystore (Q4) — and scope
 * accordingly. It grants nothing over Ring, Bee or any family surface.
 *
 * See docs/WICK-TECHNICAL.md §4.2.
 */
import type { DeviceToken } from '@wick/contracts';
import type { FileSystemLike } from '../headless/QueueStore.js';

const TOKEN_PATH = '/wick/token.json';

export interface PairingStartResponse {
  readonly code: string;
  readonly url: string;
  readonly expiresAt: number;
}

export type PairingStatusResponse =
  | { readonly status: 'pending' }
  | { readonly status: 'bound'; readonly token: DeviceToken };

export interface PairingConfig {
  readonly pairingApiUrl: string;
  readonly pollIntervalMs?: number;
  readonly pollTimeoutMs?: number;
}

const DEFAULT_POLL_INTERVAL_MS = 3000;
const DEFAULT_POLL_TIMEOUT_MS = 15 * 60 * 1000; // matches the pairing nonce's 15-minute TTL

export class PairingFlow {
  readonly #config: PairingConfig;
  readonly #fs: FileSystemLike;
  readonly #fetch: typeof fetch;

  constructor(config: PairingConfig, fs: FileSystemLike, fetchImpl: typeof fetch = fetch) {
    this.#config = config;
    this.#fs = fs;
    this.#fetch = fetchImpl;
  }

  async loadToken(): Promise<DeviceToken | null> {
    if (!(await this.#fs.exists(TOKEN_PATH))) return null;
    const raw = await this.#fs.readFileAsString(TOKEN_PATH, 'utf8');
    if (!raw) return null;
    const token = JSON.parse(raw) as DeviceToken;
    if (token.expiresAt <= Date.now()) return null;
    return token;
  }

  /** Called when the transport rejects the stored token (revoked, expired, denylisted). */
  async clearToken(): Promise<void> {
    if (await this.#fs.exists(TOKEN_PATH)) {
      await this.#fs.writeStringToFile(TOKEN_PATH, '', 'utf8');
    }
  }

  async start(deviceId: string): Promise<PairingStartResponse> {
    const res = await this.#fetch(`${this.#config.pairingApiUrl}/pair/start`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId }),
    });
    if (!res.ok) throw new Error(`pairing_start_failed: ${res.status}`);
    return (await res.json()) as PairingStartResponse;
  }

  /** Polls until Sarah claims the code, or the nonce's TTL elapses. Persists the token on success. */
  async pollUntilBound(code: string): Promise<DeviceToken> {
    const interval = this.#config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    const timeout = this.#config.pollTimeoutMs ?? DEFAULT_POLL_TIMEOUT_MS;
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const res = await this.#fetch(
        `${this.#config.pairingApiUrl}/pair/status?code=${encodeURIComponent(code)}`,
      );
      if (res.status === 404) throw new Error('pairing_code_expired');
      if (!res.ok) throw new Error(`pairing_status_failed: ${res.status}`);

      const body = (await res.json()) as PairingStatusResponse;
      if (body.status === 'bound') {
        await this.#fs.writeStringToFile(TOKEN_PATH, JSON.stringify(body.token), 'utf8');
        return body.token;
      }
      await new Promise((resolve) => setTimeout(resolve, interval));
    }
    throw new Error('pairing_timed_out');
  }
}
```

- [ ] **Step 4: Update the pairing barrel export**

Replace `apps/tv-vega/src/pairing/index.ts`:

```ts
export { PairingFlow, type PairingConfig, type PairingStartResponse, type PairingStatusResponse } from './PairingFlow.js';
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/pairing/__tests__/PairingFlow.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 6: Commit**

```bash
git add apps/tv-vega/src/pairing/PairingFlow.ts apps/tv-vega/src/pairing/index.ts \
  apps/tv-vega/src/pairing/__tests__/PairingFlow.test.ts
git commit -m "feat(vega): implement device-side PairingFlow (start/poll/persist/revoke)"
```

---

### Task 6: Backend pairing — Lambdas + infra

**Files:**
- Create: `services/edge-device/lambda/jwt.mjs`
- Test: `services/edge-device/lambda/__tests__/jwt.test.ts`
- Create: `services/edge-device/lambda/pairing-code.mjs`
- Test: `services/edge-device/lambda/__tests__/pairing-code.test.ts`
- Create: `services/edge-device/lambda/pair-start.mjs`
- Create: `services/edge-device/lambda/pair-claim.mjs`
- Create: `services/edge-device/lambda/pair-status.mjs`
- Create: `infra/pairing.tf`
- Create: `infra/bootstrap/generate-pairing-key.sh`
- Modify: `infra/outputs.tf`

**Interfaces:**
- Produces: `signJwt(claims, privateKeyPem, { expiresInSec })`, `verifyJwt(token, publicKeyPem)` (`jwt.mjs`) — consumed by `pair-claim.mjs` and, in Task 7, `connect.mjs`.
- Produces: `generatePairingCode()`, `isExpired(record, now?)`, `PAIRING_CODE_TTL_MS`, `DEVICE_TOKEN_TTL_SEC` (`pairing-code.mjs`).
- Produces DynamoDB shapes consumed later: `PAIR#<code>/META` (nonce), `HH#<id>/DEV#<deviceId>` (device binding — Task 7's `connect.mjs` reads and extends this item).

- [ ] **Step 1: Write the failing test for `jwt.mjs`**

Create `services/edge-device/lambda/__tests__/jwt.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { signJwt, verifyJwt } from '../jwt.mjs';

function testKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return {
    privateKeyPem: privateKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
    publicKeyPem: publicKey.export({ type: 'pkcs1', format: 'pem' }).toString(),
  };
}

describe('signJwt / verifyJwt', () => {
  it('round-trips claims through sign and verify', () => {
    const { privateKeyPem, publicKeyPem } = testKeyPair();
    const token = signJwt({ deviceId: 'd1', householdId: 'h1' }, privateKeyPem, { expiresInSec: 60 });

    const claims = verifyJwt(token, publicKeyPem);

    expect(claims.deviceId).toBe('d1');
    expect(claims.householdId).toBe('h1');
  });

  it('rejects an expired token', () => {
    const { privateKeyPem, publicKeyPem } = testKeyPair();
    const token = signJwt({ deviceId: 'd1', householdId: 'h1' }, privateKeyPem, { expiresInSec: -1 });

    expect(() => verifyJwt(token, publicKeyPem)).toThrow('expired');
  });

  it('rejects a token signed with a different key', () => {
    const { privateKeyPem } = testKeyPair();
    const { publicKeyPem: otherPublicKey } = testKeyPair();
    const token = signJwt({ deviceId: 'd1', householdId: 'h1' }, privateKeyPem, { expiresInSec: 60 });

    expect(() => verifyJwt(token, otherPublicKey)).toThrow('bad_signature');
  });

  it('rejects a malformed token', () => {
    const { publicKeyPem } = testKeyPair();
    expect(() => verifyJwt('not-a-jwt', publicKeyPem)).toThrow('malformed_token');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run services/edge-device/lambda/__tests__/jwt.test.ts`
Expected: FAIL — `../jwt.mjs` does not exist.

- [ ] **Step 3: Implement `jwt.mjs`**

Create `services/edge-device/lambda/jwt.mjs`:

```js
/**
 * Minimal RS256 JWT sign/verify — hand-rolled rather than a dependency, to
 * match services/edge-ring's node:crypto-only style. Only what §4.2 needs:
 * mint a device-bound token (pair-claim.mjs), verify it on WS connect
 * (connect.mjs, Task 7).
 */
import { createSign, createVerify } from 'node:crypto';

const b64url = (input) => Buffer.from(input).toString('base64url');
const b64urlJson = (obj) => b64url(JSON.stringify(obj));

export function signJwt(claims, privateKeyPem, { expiresInSec }) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const payload = { ...claims, iat: now, exp: now + expiresInSec };
  const signingInput = `${b64urlJson(header)}.${b64urlJson(payload)}`;
  const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKeyPem);
  return `${signingInput}.${signature.toString('base64url')}`;
}

export function verifyJwt(token, publicKeyPem) {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('malformed_token');
  const [headerB64, payloadB64, sigB64] = parts;

  const signingInput = `${headerB64}.${payloadB64}`;
  const signature = Buffer.from(sigB64, 'base64url');
  const ok = createVerify('RSA-SHA256').update(signingInput).verify(publicKeyPem, signature);
  if (!ok) throw new Error('bad_signature');

  const payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  const now = Math.floor(Date.now() / 1000);
  if (typeof payload.exp === 'number' && payload.exp < now) throw new Error('expired');
  return payload;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run services/edge-device/lambda/__tests__/jwt.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the failing test for `pairing-code.mjs`**

Create `services/edge-device/lambda/__tests__/pairing-code.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { generatePairingCode, isExpired, PAIRING_CODE_TTL_MS } from '../pairing-code.mjs';

describe('generatePairingCode', () => {
  it('always returns a 6-digit string', () => {
    for (let i = 0; i < 200; i++) {
      const code = generatePairingCode();
      expect(code).toMatch(/^\d{6}$/);
    }
  });
});

describe('isExpired', () => {
  it('is expired when there is no record', () => {
    expect(isExpired(undefined)).toBe(true);
  });

  it('is expired once expiresAt has passed', () => {
    const now = 1_000_000;
    expect(isExpired({ expiresAt: now - 1 }, now)).toBe(true);
    expect(isExpired({ expiresAt: now + 1 }, now)).toBe(false);
  });

  it('PAIRING_CODE_TTL_MS is 15 minutes, per §4.2', () => {
    expect(PAIRING_CODE_TTL_MS).toBe(15 * 60 * 1000);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `npx vitest run services/edge-device/lambda/__tests__/pairing-code.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 7: Implement `pairing-code.mjs`**

Create `services/edge-device/lambda/pairing-code.mjs`:

```js
/** Pure pairing-nonce logic — code generation and TTL math. No AWS. Tested. */
import { randomInt } from 'node:crypto';

export const PAIRING_CODE_TTL_MS = 15 * 60 * 1000;
export const DEVICE_TOKEN_TTL_SEC = 30 * 24 * 60 * 60;

export function generatePairingCode() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}

export function isExpired(record, now = Date.now()) {
  return !record || record.expiresAt <= now;
}
```

- [ ] **Step 8: Run the test to verify it passes**

Run: `npx vitest run services/edge-device/lambda/__tests__/pairing-code.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 9: Implement the three thin Lambda handlers**

These call DynamoDB/Secrets Manager directly and are validated by deployment, not local unit tests — matching `services/edge-ring/lambda/webhook.mjs`'s existing precedent (§12.1). Create `services/edge-device/lambda/pair-start.mjs`:

```js
/**
 * POST /pair/start {deviceId} -> {code, url, expiresAt}
 * TV boots unpaired, calls this once, displays the code and URL.
 * See docs/WICK-TECHNICAL.md §4.2.
 */
import { DynamoDBClient, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { generatePairingCode, PAIRING_CODE_TTL_MS } from './pairing-code.mjs';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;
const PAIRING_URL_BASE = process.env.PAIRING_URL_BASE;

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }
  const deviceId = body.deviceId;
  if (!deviceId) return { statusCode: 400, body: 'deviceId_required' };

  const now = Date.now();
  const expiresAt = now + PAIRING_CODE_TTL_MS;

  // Retry on the rare collision with a still-live code — the conditional
  // PutItem is the correctness guarantee, this loop is just about not failing
  // the one-in-a-million case.
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = generatePairingCode();
    try {
      await ddb.send(new PutItemCommand({
        TableName: TABLE,
        Item: {
          pk: { S: `PAIR#${code}` },
          sk: { S: 'META' },
          deviceId: { S: deviceId },
          claimed: { BOOL: false },
          expiresAt: { N: String(expiresAt) },
          ttl: { N: String(Math.floor(expiresAt / 1000)) },
        },
        ConditionExpression: 'attribute_not_exists(pk)',
      }));
      return {
        statusCode: 200,
        body: JSON.stringify({ code, url: `${PAIRING_URL_BASE}/${code}`, expiresAt }),
      };
    } catch (err) {
      if (err?.name !== 'ConditionalCheckFailedException') throw err;
    }
  }
  return { statusCode: 503, body: 'code_space_exhausted' };
};
```

Create `services/edge-device/lambda/pair-claim.mjs`:

```js
/**
 * POST /pair/claim {code, householdId} — Sarah's device confirms binding.
 *
 * Household identity is simplified for this pass: no Amazon-account sign-in
 * exists anywhere in this repo (see the plan's Scope decisions and
 * FRICTION.md), so a household is provisioned out of band and its id passed
 * in directly — matching how `environment = dev | home` already models
 * "there is one real household" (§13.3).
 *
 * Binds deviceId <-> householdId, mints the device-bound JWT (§4.2 step 3),
 * and stores it on the pairing nonce for the TV's next poll to collect.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { signJwt } from './jwt.mjs';
import { isExpired, DEVICE_TOKEN_TTL_SEC } from './pairing-code.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const TABLE = process.env.TABLE_NAME;
const SIGNING_KEY_SECRET_ARN = process.env.PAIRING_SIGNING_KEY_SECRET_ARN;

let cachedPrivateKey = null;
async function privateKey() {
  if (cachedPrivateKey) return cachedPrivateKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SIGNING_KEY_SECRET_ARN }));
  cachedPrivateKey = JSON.parse(r.SecretString).privateKeyPem;
  return cachedPrivateKey;
}

export const handler = async (event) => {
  let body;
  try {
    body = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }
  const { code, householdId } = body;
  if (!code || !householdId) return { statusCode: 400, body: 'code_and_householdId_required' };

  const existing = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
  }));
  const item = existing.Item;
  if (!item) return { statusCode: 404, body: 'unknown_or_expired_code' };
  if (isExpired({ expiresAt: Number(item.expiresAt.N) })) return { statusCode: 410, body: 'code_expired' };
  if (item.claimed?.BOOL) return { statusCode: 409, body: 'already_claimed' };

  const deviceId = item.deviceId.S;
  const key = await privateKey();
  const jwt = signJwt({ deviceId, householdId }, key, { expiresInSec: DEVICE_TOKEN_TTL_SEC });
  const tokenExpiresAt = Date.now() + DEVICE_TOKEN_TTL_SEC * 1000;

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `DEV#${deviceId}` },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      denylisted: { BOOL: false },
      pairedAt: { N: String(Date.now()) },
    },
  }));

  await ddb.send(new UpdateItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
    UpdateExpression: 'SET claimed = :true, deliveryToken = :tok',
    ExpressionAttributeValues: {
      ':true': { BOOL: true },
      ':tok': { S: JSON.stringify({ jwt, deviceId, householdId, expiresAt: tokenExpiresAt }) },
    },
  }));

  return { statusCode: 200, body: JSON.stringify({ ok: true }) };
};
```

Create `services/edge-device/lambda/pair-status.mjs`:

```js
/**
 * GET /pair/status?code=XXXXXX — the TV polls this until it is bound.
 * Delivers the token exactly once: the pairing nonce is deleted on delivery,
 * so a stolen or replayed code that already delivered gets 404, not a second
 * copy of the token.
 */
import { DynamoDBClient, GetItemCommand, DeleteItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

export const handler = async (event) => {
  const code = event.queryStringParameters?.code;
  if (!code) return { statusCode: 400, body: 'code_required' };

  const existing = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
  }));
  const item = existing.Item;
  if (!item) return { statusCode: 404, body: 'unknown_or_expired_code' };

  if (!item.claimed?.BOOL) {
    return { statusCode: 200, body: JSON.stringify({ status: 'pending' }) };
  }

  const token = JSON.parse(item.deliveryToken.S);
  await ddb.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `PAIR#${code}` }, sk: { S: 'META' } },
  }));
  return { statusCode: 200, body: JSON.stringify({ status: 'bound', token }) };
};
```

- [ ] **Step 10: Write Terraform for the pairing signing key and Lambdas**

Create `infra/pairing.tf`:

```hcl
# ---------------------------------------------------------------------------
# Device pairing. §4.2. Not applied by this pass — see the plan's global
# constraints ("code + tests only"). Reviewed for correctness, not yet run.
# ---------------------------------------------------------------------------

resource "aws_secretsmanager_secret" "pairing_signing_key" {
  name        = "${local.prefix}/pairing/signing-key"
  description = "RS256 keypair used to mint and verify device-bound JWTs (INV-1, §4.2)"

  recovery_window_in_days = 7

  lifecycle {
    prevent_destroy = true
  }
}

data "archive_file" "edge_device" {
  type        = "zip"
  source_dir  = "${path.module}/../services/edge-device/lambda"
  output_path = "${path.module}/.build/edge-device.zip"
  excludes    = ["__tests__"]
}

resource "aws_iam_role" "pair_start" {
  name               = "${local.prefix}-pair-start"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "pair_claim" {
  name               = "${local.prefix}-pair-claim"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "pair_status" {
  name               = "${local.prefix}-pair-status"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "pairing_basic" {
  for_each = {
    start  = aws_iam_role.pair_start.name
    claim  = aws_iam_role.pair_claim.name
    status = aws_iam_role.pair_status.name
  }
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "pair_start" {
  statement {
    sid       = "WriteNonce"
    actions   = ["dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

data "aws_iam_policy_document" "pair_claim" {
  statement {
    sid       = "ReadUpdateNonceAndDevice"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:UpdateItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "ReadSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pairing_signing_key.arn]
  }
}

data "aws_iam_policy_document" "pair_status" {
  statement {
    sid       = "ReadDeleteNonce"
    actions   = ["dynamodb:GetItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

resource "aws_iam_role_policy" "pair_start" {
  name   = "${local.prefix}-pair-start"
  role   = aws_iam_role.pair_start.id
  policy = data.aws_iam_policy_document.pair_start.json
}

resource "aws_iam_role_policy" "pair_claim" {
  name   = "${local.prefix}-pair-claim"
  role   = aws_iam_role.pair_claim.id
  policy = data.aws_iam_policy_document.pair_claim.json
}

resource "aws_iam_role_policy" "pair_status" {
  name   = "${local.prefix}-pair-status"
  role   = aws_iam_role.pair_status.id
  policy = data.aws_iam_policy_document.pair_status.json
}

resource "aws_cloudwatch_log_group" "pair_start" {
  name              = "/aws/lambda/${local.prefix}-pair-start"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "pair_claim" {
  name              = "/aws/lambda/${local.prefix}-pair-claim"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "pair_status" {
  name              = "/aws/lambda/${local.prefix}-pair-status"
  retention_in_days = 14
}

resource "aws_lambda_function" "pair_start" {
  function_name = "${local.prefix}-pair-start"
  role          = aws_iam_role.pair_start.arn
  handler       = "pair-start.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME       = aws_dynamodb_table.wick.name
      PAIRING_URL_BASE = var.pairing_url_base
    }
  }

  depends_on = [aws_cloudwatch_log_group.pair_start]
}

resource "aws_lambda_function" "pair_claim" {
  function_name = "${local.prefix}-pair-claim"
  role          = aws_iam_role.pair_claim.arn
  handler       = "pair-claim.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME                     = aws_dynamodb_table.wick.name
      PAIRING_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.pairing_signing_key.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.pair_claim]
}

resource "aws_lambda_function" "pair_status" {
  function_name = "${local.prefix}-pair-status"
  role          = aws_iam_role.pair_status.arn
  handler       = "pair-status.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME = aws_dynamodb_table.wick.name
    }
  }

  depends_on = [aws_cloudwatch_log_group.pair_status]
}

locals {
  pairing_routes = {
    "POST /pair/start"  = aws_lambda_function.pair_start
    "POST /pair/claim"  = aws_lambda_function.pair_claim
    "GET /pair/status"  = aws_lambda_function.pair_status
  }
}

resource "aws_apigatewayv2_integration" "pairing" {
  for_each = local.pairing_routes

  api_id                 = aws_apigatewayv2_api.edge.id
  integration_type       = "AWS_PROXY"
  integration_uri        = each.value.invoke_arn
  payload_format_version = "2.0"
}

resource "aws_apigatewayv2_route" "pairing" {
  for_each = local.pairing_routes

  api_id    = aws_apigatewayv2_api.edge.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.pairing[each.key].id}"
}

resource "aws_lambda_permission" "pairing" {
  for_each = local.pairing_routes

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.edge.execution_arn}/*/*"
}
```

Add to `infra/variables.tf`:

```hcl
variable "pairing_url_base" {
  description = "Short URL shown on the TV's pairing screen, e.g. https://wick.example/pair. §4.2."
  type        = string
  default     = "https://rogerjeasy.github.io/wick/pair"
}
```

Add to `infra/outputs.tf`:

```hcl
output "pairing_api_url" {
  description = "Set as apps/tv-vega/src/config.ts DEPLOYED.pairingApiUrl"
  value       = aws_apigatewayv2_api.edge.api_endpoint
}

output "pairing_signing_key_secret" {
  description = "Populate with infra/bootstrap/generate-pairing-key.sh"
  value       = aws_secretsmanager_secret.pairing_signing_key.name
}
```

- [ ] **Step 11: Write the signing-key bootstrap script**

Create `infra/bootstrap/generate-pairing-key.sh`:

```bash
#!/usr/bin/env bash
#
# Generates the RS256 keypair used to sign and verify device-bound JWTs
# (§4.2) and seeds it into Secrets Manager. Run once per environment, after
# `terraform apply` has created the secret.
#
set -euo pipefail

PROFILE="${AWS_PROFILE:-wick-dev}"
SECRET="${1:-wick/pairing/signing-key}"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

openssl genrsa -out "$TMP_DIR/private.pem" 2048 >/dev/null 2>&1
openssl rsa -in "$TMP_DIR/private.pem" -pubout -out "$TMP_DIR/public.pem" >/dev/null 2>&1

python3 -c "
import json, sys
json.dump({
    'privateKeyPem': open(sys.argv[1]).read(),
    'publicKeyPem':  open(sys.argv[2]).read(),
}, open(sys.argv[3], 'w'))
" "$TMP_DIR/private.pem" "$TMP_DIR/public.pem" "$TMP_DIR/secret.json"

aws secretsmanager put-secret-value \
  --secret-id "$SECRET" \
  --secret-string "file://$TMP_DIR/secret.json" \
  --profile "$PROFILE" \
  --query 'Name' --output text

echo "populated: privateKeyPem, publicKeyPem"
```

Run: `chmod +x infra/bootstrap/generate-pairing-key.sh`

- [ ] **Step 12: Validate Terraform syntax**

Run: `terraform -chdir=infra fmt -check -diff` (fix formatting if it flags anything, then re-run)
Run: `terraform -chdir=infra validate`
Expected: `Success! The configuration is valid.` — this does **not** apply anything; it only checks syntax and internal consistency. Do not run `terraform apply` or `npm run tf:apply`.

- [ ] **Step 13: Log the FRICTION.md entry from Scope decision 2**

Use the `win-hackathon:log` skill or append directly to `FRICTION.md` with all six required fields, documenting that the SP-5 hardware spike is still pending and IoT Core infra is deliberately not yet stood up.

- [ ] **Step 14: Commit**

```bash
git add services/edge-device/lambda/jwt.mjs services/edge-device/lambda/__tests__/jwt.test.ts \
  services/edge-device/lambda/pairing-code.mjs services/edge-device/lambda/__tests__/pairing-code.test.ts \
  services/edge-device/lambda/pair-start.mjs services/edge-device/lambda/pair-claim.mjs \
  services/edge-device/lambda/pair-status.mjs infra/pairing.tf infra/variables.tf infra/outputs.tf \
  infra/bootstrap/generate-pairing-key.sh FRICTION.md
git commit -m "feat(edge-device): pairing Lambdas — start/claim/status, RS256 signing key"
```

---

### Task 7: Backend WebSocket Lambdas — `connect`/`disconnect`/`route` + infra

**Files:**
- Create: `services/edge-device/lambda/connect.mjs`
- Create: `services/edge-device/lambda/disconnect.mjs`
- Create: `services/edge-device/lambda/route.mjs`
- Create: `infra/transport.tf`
- Modify: `infra/outputs.tf`

**Interfaces:**
- Consumes: `verifyJwt` from `jwt.mjs` (Task 6).
- Produces DynamoDB shapes consumed by `services/agent/src/egress.ts` (Task 8): `HH#<id>/DEV#<deviceId>` gains `connectionId`, `transport`, `wsEndpoint`, `connectedAt`; `CONN#<connectionId>/META` reverse lookup.

- [ ] **Step 1: Implement `connect.mjs`**

Not locally unit-tested — see Task 6 Step 9's rationale. Create `services/edge-device/lambda/connect.mjs`:

```js
/**
 * WebSocket $connect.
 *
 *   - verify the device-bound JWT (RS256), check the deviceId denylist
 *   - store the connectionId on the Device item, plus a reverse lookup so
 *     $disconnect can find it again (API Gateway hands $disconnect nothing
 *     but the connectionId)
 *   - reconcile: the client sends lastSeenCardId in the query string;
 *     anything queued after it goes out now, over this same connection
 *
 * See docs/WICK-TECHNICAL.md §4.1, §4.2.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand, QueryCommand } from '@aws-sdk/client-dynamodb';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';
import { verifyJwt } from './jwt.mjs';

const ddb = new DynamoDBClient({});
const sm = new SecretsManagerClient({});
const TABLE = process.env.TABLE_NAME;
const SIGNING_KEY_SECRET_ARN = process.env.PAIRING_SIGNING_KEY_SECRET_ARN;

let cachedPublicKey = null;
async function publicKey() {
  if (cachedPublicKey) return cachedPublicKey;
  const r = await sm.send(new GetSecretValueCommand({ SecretId: SIGNING_KEY_SECRET_ARN }));
  cachedPublicKey = JSON.parse(r.SecretString).publicKeyPem;
  return cachedPublicKey;
}

export const handler = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) return { statusCode: 401, body: 'token_required' };

  let claims;
  try {
    claims = verifyJwt(token, await publicKey());
  } catch {
    return { statusCode: 401, body: 'invalid_token' };
  }
  const { deviceId, householdId } = claims;

  const device = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
  }));
  if (!device.Item || device.Item.denylisted?.BOOL) {
    return { statusCode: 403, body: 'revoked' };
  }

  const connectionId = event.requestContext.connectionId;
  const wsEndpoint = `https://${event.requestContext.domainName}/${event.requestContext.stage}`;

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `HH#${householdId}` },
      sk: { S: `DEV#${deviceId}` },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      denylisted: { BOOL: false },
      connectionId: { S: connectionId },
      transport: { S: 'websocket' },
      wsEndpoint: { S: wsEndpoint },
      connectedAt: { N: String(Date.now()) },
    },
  }));

  await ddb.send(new PutItemCommand({
    TableName: TABLE,
    Item: {
      pk: { S: `CONN#${connectionId}` },
      sk: { S: 'META' },
      deviceId: { S: deviceId },
      householdId: { S: householdId },
      ttl: { N: String(Math.floor(Date.now() / 1000) + 86400) }, // stale-connection backstop
    },
  }));

  await reconcile({ event, householdId, connectionId, wsEndpoint });

  return { statusCode: 200, body: '' };
};

async function reconcile({ event, householdId, connectionId, wsEndpoint }) {
  const sinceCardId = event.queryStringParameters?.lastSeenCardId;

  const pending = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':prefix': { S: 'CARD#' },
    },
  }));

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });

  for (const item of pending.Items ?? []) {
    const card = JSON.parse(item.data.S);
    if (sinceCardId && card.id <= sinceCardId) continue; // ULIDs sort lexicographically by creation time (INV-6)
    try {
      await mgmt.send(new PostToConnectionCommand({
        ConnectionId: connectionId,
        Data: JSON.stringify({ kind: 'card', card }),
      }));
    } catch (err) {
      if (err?.name !== 'GoneException') throw err;
    }
  }
}
```

- [ ] **Step 2: Implement `disconnect.mjs`**

Create `services/edge-device/lambda/disconnect.mjs`:

```js
/** WebSocket $disconnect — clears the connection, only if it is still ours. */
import { DynamoDBClient, GetItemCommand, DeleteItemCommand, UpdateItemCommand } from '@aws-sdk/client-dynamodb';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;

  const lookup = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));
  if (!lookup.Item) return { statusCode: 200, body: '' };

  const deviceId = lookup.Item.deviceId.S;
  const householdId = lookup.Item.householdId.S;

  try {
    await ddb.send(new UpdateItemCommand({
      TableName: TABLE,
      Key: { pk: { S: `HH#${householdId}` }, sk: { S: `DEV#${deviceId}` } },
      UpdateExpression: 'REMOVE connectionId, transport, wsEndpoint',
      ConditionExpression: 'connectionId = :cid',
      ExpressionAttributeValues: { ':cid': { S: connectionId } },
    }));
  } catch (err) {
    if (err?.name !== 'ConditionalCheckFailedException') throw err; // a newer connection already replaced it
  }

  await ddb.send(new DeleteItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));

  return { statusCode: 200, body: '' };
};
```

- [ ] **Step 3: Implement `route.mjs`**

Create `services/edge-device/lambda/route.mjs`:

```js
/**
 * WebSocket `$default` — inbound DeviceEvent. §4.3.
 *
 * card_shown / card_action are persisted to the timeline now, because INV-6's
 * correlation loop closes here. playback / break_state / app_lifecycle are
 * the Rhythm pillar's input (§3.3, §8.2) and land in Timestream once S6
 * wires that pipeline — accepted and acknowledged here, not yet persisted.
 */
import { DynamoDBClient, GetItemCommand, PutItemCommand } from '@aws-sdk/client-dynamodb';
import { randomUUID } from 'node:crypto';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME;

export const handler = async (event) => {
  const connectionId = event.requestContext.connectionId;
  let deviceEvent;
  try {
    deviceEvent = JSON.parse(event.body ?? '{}');
  } catch {
    return { statusCode: 400, body: 'bad_json' };
  }

  const lookup = await ddb.send(new GetItemCommand({
    TableName: TABLE,
    Key: { pk: { S: `CONN#${connectionId}` }, sk: { S: 'META' } },
  }));
  if (!lookup.Item) return { statusCode: 401, body: 'unknown_connection' };
  const householdId = lookup.Item.householdId.S;

  if (deviceEvent.t === 'card_shown' || deviceEvent.t === 'card_action') {
    await ddb.send(new PutItemCommand({
      TableName: TABLE,
      Item: {
        pk: { S: `HH#${householdId}` },
        sk: { S: `EVT#${String(deviceEvent.at).padStart(15, '0')}#${randomUUID()}` },
        type: { S: deviceEvent.t },
        cardId: { S: deviceEvent.cardId },
        ...(deviceEvent.action ? { action: { S: deviceEvent.action } } : {}),
      },
    }));
  }

  return { statusCode: 200, body: '' };
};
```

- [ ] **Step 4: Write Terraform for the WebSocket API**

Create `infra/transport.tf`:

```hcl
# ---------------------------------------------------------------------------
# Device transport, option B (§4.1). Not applied by this pass — see the
# plan's global constraints. Reviewed for correctness, not yet run.
#
# Option A (IoT Core / MQTT) is deliberately absent — see the plan's Scope
# decisions and FRICTION.md. MqttChannel.ts ships real client code with
# nothing live to point it at yet.
# ---------------------------------------------------------------------------

resource "aws_iam_role" "ws_connect" {
  name               = "${local.prefix}-ws-connect"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "ws_disconnect" {
  name               = "${local.prefix}-ws-disconnect"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role" "ws_route" {
  name               = "${local.prefix}-ws-route"
  assume_role_policy = data.aws_iam_policy_document.lambda_assume.json
}

resource "aws_iam_role_policy_attachment" "ws_basic" {
  for_each = {
    connect    = aws_iam_role.ws_connect.name
    disconnect = aws_iam_role.ws_disconnect.name
    route      = aws_iam_role.ws_route.name
  }
  role       = each.value
  policy_arn = "arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole"
}

data "aws_iam_policy_document" "ws_connect" {
  statement {
    sid       = "ReadWriteDeviceAndConnection"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem", "dynamodb:Query"]
    resources = [aws_dynamodb_table.wick.arn]
  }
  statement {
    sid       = "ReadSigningKey"
    actions   = ["secretsmanager:GetSecretValue"]
    resources = [aws_secretsmanager_secret.pairing_signing_key.arn]
  }
  statement {
    sid       = "PushReconcileCards"
    actions   = ["execute-api:ManageConnections"]
    resources = ["${aws_apigatewayv2_api.transport.execution_arn}/*/*"]
  }
}

data "aws_iam_policy_document" "ws_disconnect" {
  statement {
    sid       = "ReadUpdateDeleteConnection"
    actions   = ["dynamodb:GetItem", "dynamodb:UpdateItem", "dynamodb:DeleteItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

data "aws_iam_policy_document" "ws_route" {
  statement {
    sid       = "ReadConnectionWriteTimeline"
    actions   = ["dynamodb:GetItem", "dynamodb:PutItem"]
    resources = [aws_dynamodb_table.wick.arn]
  }
}

resource "aws_iam_role_policy" "ws_connect" {
  name   = "${local.prefix}-ws-connect"
  role   = aws_iam_role.ws_connect.id
  policy = data.aws_iam_policy_document.ws_connect.json
}

resource "aws_iam_role_policy" "ws_disconnect" {
  name   = "${local.prefix}-ws-disconnect"
  role   = aws_iam_role.ws_disconnect.id
  policy = data.aws_iam_policy_document.ws_disconnect.json
}

resource "aws_iam_role_policy" "ws_route" {
  name   = "${local.prefix}-ws-route"
  role   = aws_iam_role.ws_route.id
  policy = data.aws_iam_policy_document.ws_route.json
}

resource "aws_cloudwatch_log_group" "ws_connect" {
  name              = "/aws/lambda/${local.prefix}-ws-connect"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "ws_disconnect" {
  name              = "/aws/lambda/${local.prefix}-ws-disconnect"
  retention_in_days = 14
}

resource "aws_cloudwatch_log_group" "ws_route" {
  name              = "/aws/lambda/${local.prefix}-ws-route"
  retention_in_days = 14
}

resource "aws_lambda_function" "ws_connect" {
  function_name = "${local.prefix}-ws-connect"
  role          = aws_iam_role.ws_connect.arn
  handler       = "connect.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = {
      TABLE_NAME                     = aws_dynamodb_table.wick.name
      PAIRING_SIGNING_KEY_SECRET_ARN = aws_secretsmanager_secret.pairing_signing_key.arn
    }
  }

  depends_on = [aws_cloudwatch_log_group.ws_connect]
}

resource "aws_lambda_function" "ws_disconnect" {
  function_name = "${local.prefix}-ws-disconnect"
  role          = aws_iam_role.ws_disconnect.arn
  handler       = "disconnect.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.wick.name }
  }

  depends_on = [aws_cloudwatch_log_group.ws_disconnect]
}

resource "aws_lambda_function" "ws_route" {
  function_name = "${local.prefix}-ws-route"
  role          = aws_iam_role.ws_route.arn
  handler       = "route.handler"
  runtime       = "nodejs22.x"
  architectures = ["arm64"]

  filename         = data.archive_file.edge_device.output_path
  source_code_hash = data.archive_file.edge_device.output_base64sha256

  timeout     = 10
  memory_size = 256

  environment {
    variables = { TABLE_NAME = aws_dynamodb_table.wick.name }
  }

  depends_on = [aws_cloudwatch_log_group.ws_route]
}

resource "aws_apigatewayv2_api" "transport" {
  name                       = "${local.prefix}-transport"
  protocol_type              = "WEBSOCKET"
  route_selection_expression = "$request.body.action"
}

resource "aws_apigatewayv2_stage" "transport" {
  api_id      = aws_apigatewayv2_api.transport.id
  name        = "prod"
  auto_deploy = true

  default_route_settings {
    throttling_burst_limit = 50
    throttling_rate_limit  = 100
  }
}

locals {
  transport_routes = {
    "$connect"    = aws_lambda_function.ws_connect
    "$disconnect" = aws_lambda_function.ws_disconnect
    "$default"    = aws_lambda_function.ws_route
  }
}

resource "aws_apigatewayv2_integration" "transport" {
  for_each = local.transport_routes

  api_id             = aws_apigatewayv2_api.transport.id
  integration_type   = "AWS_PROXY"
  integration_uri    = each.value.invoke_arn
  content_handling_strategy = "CONVERT_TO_TEXT"
}

resource "aws_apigatewayv2_route" "transport" {
  for_each = local.transport_routes

  api_id    = aws_apigatewayv2_api.transport.id
  route_key = each.key
  target    = "integrations/${aws_apigatewayv2_integration.transport[each.key].id}"
}

resource "aws_lambda_permission" "transport" {
  for_each = local.transport_routes

  statement_id  = "AllowAPIGatewayInvoke"
  action        = "lambda:InvokeFunction"
  function_name = each.value.function_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.transport.execution_arn}/*/*"
}
```

Add to `infra/outputs.tf`:

```hcl
output "websocket_url" {
  description = "Set as apps/tv-vega/src/config.ts DEPLOYED.websocketUrl"
  value       = "wss://${replace(aws_apigatewayv2_api.transport.api_endpoint, "https://", "")}/${aws_apigatewayv2_stage.transport.name}"
}
```

- [ ] **Step 5: Validate Terraform syntax**

Run: `terraform -chdir=infra fmt -check -diff` (fix formatting if flagged, re-run)
Run: `terraform -chdir=infra validate`
Expected: `Success! The configuration is valid.` Do not `apply`.

- [ ] **Step 6: Commit**

```bash
git add services/edge-device/lambda/connect.mjs services/edge-device/lambda/disconnect.mjs \
  services/edge-device/lambda/route.mjs infra/transport.tf infra/outputs.tf
git commit -m "feat(edge-device): WebSocket connect/disconnect/route Lambdas + API Gateway infra"
```

---

### Task 8: `services/agent/src/egress.ts` — implement `sendToDevice()`

**Files:**
- Modify: `services/agent/src/egress.ts`
- Modify: `services/agent/package.json`

**Interfaces:**
- Consumes: `QueuedCard`, `HouseholdPolicy` (already imported). Adds `@aws-sdk/client-dynamodb`, `@aws-sdk/client-apigatewaymanagementapi` — both permitted here per INV-2 (egress.ts is the one file in the eslint ignore list).
- This function is not unit-tested locally, matching the AWS-SDK-touching convention established in Task 6/7 — `sendToFamily()` above it in the same file is untouched by this task and stays a stub (out of scope; that's the S5 Guardian egress work, priority #2 from the earlier conversation, not S1).

- [ ] **Step 1: Add the AWS SDK dependencies**

In `services/agent/package.json`, add to `"dependencies"`:

```json
"@aws-sdk/client-dynamodb": "^3.1132.0",
"@aws-sdk/client-apigatewaymanagementapi": "^3.1132.0",
```

Run: `npm install`

- [ ] **Step 2: Implement `sendToDevice()`**

In `services/agent/src/egress.ts`, add imports at the top (after the existing `@wick/policy` and `@wick/contracts` imports):

```ts
import { DynamoDBClient, PutItemCommand, QueryCommand, UpdateItemCommand, type AttributeValue } from '@aws-sdk/client-dynamodb';
import { ApiGatewayManagementApiClient, PostToConnectionCommand } from '@aws-sdk/client-apigatewaymanagementapi';

const ddb = new DynamoDBClient({});
const TABLE = process.env.TABLE_NAME ?? '';
```

Replace the existing `sendToDevice` stub:

```ts
/**
 * The only path to the television.
 *
 * The resident is always audience RESIDENT, so the Guardian is permissive here —
 * but it still runs, because "the resident sees everything about themselves" is a
 * policy decision, not an absence of policy.
 */
export async function sendToDevice(
  card: QueuedCard,
  _policy: HouseholdPolicy,
): Promise<void> {
  const householdId = card.card.householdId;

  // The Card item is the queue's source of truth — written unconditionally,
  // before any attempt at a live push, so connect.mjs's reconcile step can
  // always deliver it later even if the device is offline right now.
  const item: Record<string, AttributeValue> = {
    pk: { S: `HH#${householdId}` },
    sk: { S: `CARD#${card.id}` },
    data: { S: JSON.stringify(card) },
  };
  if (card.expiresAt !== undefined) {
    item.ttl = { N: String(Math.floor(card.expiresAt / 1000)) };
  }
  await ddb.send(new PutItemCommand({ TableName: TABLE, Item: item }));

  const deviceLookup = await ddb.send(new QueryCommand({
    TableName: TABLE,
    KeyConditionExpression: 'pk = :pk AND begins_with(sk, :prefix)',
    ExpressionAttributeValues: {
      ':pk': { S: `HH#${householdId}` },
      ':prefix': { S: 'DEV#' },
    },
    Limit: 1,
  }));
  const deviceItem = deviceLookup.Items?.[0];
  const connectionId = deviceItem?.connectionId?.S;
  const transport = deviceItem?.transport?.S;
  const wsEndpoint = deviceItem?.wsEndpoint?.S;

  if (!connectionId || transport !== 'websocket' || !wsEndpoint) {
    // Offline, or on the MQTT path — IoT Core publish isn't wired up yet
    // (SP-5 gate, see the implementation plan's Scope decisions and
    // FRICTION.md). The Card item above is the queue; connect.mjs's
    // reconcile step delivers it the moment the device is next seen.
    return;
  }

  const mgmt = new ApiGatewayManagementApiClient({ endpoint: wsEndpoint });
  try {
    await mgmt.send(new PostToConnectionCommand({
      ConnectionId: connectionId,
      Data: JSON.stringify({ kind: 'card', card }),
    }));
  } catch (err) {
    if ((err as { name?: string }).name === 'GoneException') {
      const deviceSk = deviceItem?.sk?.S;
      if (deviceSk) {
        await ddb.send(new UpdateItemCommand({
          TableName: TABLE,
          Key: { pk: { S: `HH#${householdId}` }, sk: { S: deviceSk } },
          UpdateExpression: 'REMOVE connectionId, transport, wsEndpoint',
        }));
      }
      return;
    }
    throw err;
  }
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: no errors. This is the step that actually proves the new AWS SDK imports resolve — if `npm install` in Step 1 didn't pick them up, this fails loudly here rather than at deploy time.

- [ ] **Step 4: Run the full test suite to confirm nothing else broke**

Run: `npm run test`
Expected: all existing suites still pass (this task adds no new test file — the function isn't unit-tested per the Task 6/7 convention — but a typo could still break `services/agent`'s other tests via a bad import).

- [ ] **Step 5: Commit**

```bash
git add services/agent/src/egress.ts services/agent/package.json package-lock.json
git commit -m "feat(agent): implement egress.sendToDevice — DDB queue write + WS push"
```

---

### Task 9: `CardService`

**Files:**
- Modify: `apps/tv-vega/src/headless/CardService.ts`
- Test: `apps/tv-vega/src/headless/__tests__/CardService.test.ts`

**Interfaces:**
- Consumes: `createDeviceChannel` (Task 3), `QueueStore` (Task 4), `PairingFlow` (Task 5), `loadDeviceConfig` (Task 4).
- The registered headless hook keeps its original no-argument signature (`onStartCardService(): Promise<void>`, `onStopCardService(): Promise<void>`) to match `service.js`'s existing `registerHeadlessEntryPoint2('...', () => onStartCardService)` wiring — do not add parameters.
- Because this directly wires `createDeviceChannel` end-to-end with real timers (outbox flush interval), the test injects all four dependencies through a not-yet-existing `configureCardServiceForTest()` seam — see Step 1.

- [ ] **Step 1: Write the failing test**

`CardService`'s registered hooks are parameterless by contract, so the test needs a seam to inject fakes. Create `apps/tv-vega/src/headless/__tests__/CardService.test.ts`:

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import type { QueuedCard } from '@wick/contracts';
import {
  onStartCardService,
  onStopCardService,
  __setCardServiceTestDeps,
} from '../CardService.js';
import { QueueStore, type FileSystemLike } from '../QueueStore.js';

function fakeFs(): FileSystemLike {
  const files = new Map<string, string>();
  return {
    async exists(path) {
      return files.has(path) && files.get(path) !== '';
    },
    async readFileAsString(path) {
      return files.get(path) ?? '';
    },
    async writeStringToFile(path, content) {
      files.set(path, content);
      return content.length;
    },
  };
}

afterEach(async () => {
  await onStopCardService();
  __setCardServiceTestDeps(null);
  vi.useRealTimers();
});

describe('CardService', () => {
  it('does nothing when unpaired (no stored token)', async () => {
    const fs = fakeFs();
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: async () => {
        throw new Error('should not be called when unpaired');
      },
    });

    await expect(onStartCardService()).resolves.toBeUndefined();
  });

  it('connects and writes an inbound card to the QueueStore', async () => {
    const fs = fakeFs();
    await fs.writeStringToFile(
      '/wick/token.json',
      JSON.stringify({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 }),
      'utf8',
    );

    let cardHandler: ((c: QueuedCard) => void) | undefined;
    const sent: unknown[] = [];
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: async () => ({
        state: 'open' as const,
        onCard: (h: (c: QueuedCard) => void) => {
          cardHandler = h;
          return () => undefined;
        },
        onControl: () => () => undefined,
        send: async (e: unknown) => {
          sent.push(e);
        },
        connect: async () => undefined,
      }),
    });

    await onStartCardService();

    const card: QueuedCard = {
      id: 'c1',
      urgency: 'DOOR',
      card: { type: 'DOOR', id: 'c1', householdId: 'h1', correlationId: 'x', createdAt: 0, actions: [], line: 'hi' },
      queuedAt: 0,
      shownCount: 0,
    };
    cardHandler?.(card);
    await Promise.resolve(); // let the fire-and-forget upsert/send settle

    const store = new QueueStore(fs);
    expect((await store.readAll()).map((c) => c.id)).toEqual(['c1']);
    expect(sent).toEqual([{ t: 'card_shown', cardId: 'c1', at: expect.any(Number) }]);
  });

  it('flushes queued outbound events on its poll interval', async () => {
    vi.useFakeTimers();
    const fs = fakeFs();
    await fs.writeStringToFile(
      '/wick/token.json',
      JSON.stringify({ jwt: 'j', deviceId: 'd1', householdId: 'h1', expiresAt: Date.now() + 100_000 }),
      'utf8',
    );
    const store = new QueueStore(fs);
    await store.enqueueOutbound({ t: 'card_action', cardId: 'c1', action: 'answer', at: 1 });

    const sent: unknown[] = [];
    __setCardServiceTestDeps({
      fs,
      config: { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example' },
      createChannel: async () => ({
        state: 'open' as const,
        onCard: () => () => undefined,
        onControl: () => () => undefined,
        send: async (e: unknown) => {
          sent.push(e);
        },
        connect: async () => undefined,
      }),
    });

    await onStartCardService();
    await vi.advanceTimersByTimeAsync(1100);

    expect(sent).toEqual([{ t: 'card_action', cardId: 'c1', action: 'answer', at: 1 }]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run apps/tv-vega/src/headless/__tests__/CardService.test.ts`
Expected: FAIL — `__setCardServiceTestDeps` doesn't exist; `onStartCardService` throws `not implemented`.

- [ ] **Step 3: Implement `CardService`**

Replace `apps/tv-vega/src/headless/CardService.ts` entirely:

```ts
/**
 * com.wick.tv.card.service — holds the device channel while the app package is
 * alive, so a card can arrive without the UI being mounted.
 *
 * Isolated in its own process group (manifest.toml) so a UI crash cannot drop
 * the channel.
 *
 * NOTE: this does NOT make Wick able to draw over another app's playback. That
 * is SP-1, the project's pivot question. See docs/WICK-TECHNICAL.md §14.
 */
import KeplerFileSystem from '@amazon-devices/kepler-file-system';
import type { ControlMessage, DeviceChannel, QueuedCard } from '@wick/contracts';
import { createDeviceChannel, type DeviceChannelConfig } from '../transport/createDeviceChannel.js';
import { QueueStore, type FileSystemLike } from './QueueStore.js';
import { PairingFlow } from '../pairing/PairingFlow.js';
import { loadDeviceConfig, type DeviceConfig } from '../config.js';

const OUTBOX_POLL_MS = 1000;

interface TestDeps {
  readonly fs: FileSystemLike;
  readonly config: DeviceConfig;
  readonly createChannel: (config: DeviceChannelConfig, token: Parameters<typeof createDeviceChannel>[1]) => Promise<DeviceChannel>;
}

let testDeps: TestDeps | null = null;

/** Test-only seam — the registered headless hooks below stay parameterless. */
export function __setCardServiceTestDeps(deps: TestDeps | null): void {
  testDeps = deps;
}

let channel: DeviceChannel | undefined;
let unsubscribeCard: (() => void) | undefined;
let unsubscribeControl: (() => void) | undefined;
let outboxTimer: ReturnType<typeof setInterval> | undefined;

export async function onStartCardService(): Promise<void> {
  const fs = testDeps?.fs ?? KeplerFileSystem;
  const config = testDeps?.config ?? loadDeviceConfig();
  const createChannel = testDeps?.createChannel ?? createDeviceChannel;

  const store = new QueueStore(fs);
  const pairing = new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, fs);

  const token = await pairing.loadToken();
  if (!token) return; // unpaired — App.tsx shows the pairing screen; nothing to hold open yet

  const channelConfig: DeviceChannelConfig = {
    websocket: { url: config.websocketUrl, getLastSeenCardId: () => store.lastSeenCardId() },
    ...(config.mqttWssUrl ? { mqtt: { wssUrl: config.mqttWssUrl } } : {}),
  };

  channel = await createChannel(channelConfig, token);

  unsubscribeCard = channel.onCard((card: QueuedCard) => {
    void store.upsert(card);
    void channel?.send({ t: 'card_shown', cardId: card.id, at: Date.now() });
  });

  unsubscribeControl = channel.onControl((msg: ControlMessage) => {
    if (msg.t === 'patch') void store.applyPatch(msg.patch);
    else if (msg.t === 'revoke') void store.remove(msg.cardId);
  });

  outboxTimer = setInterval(() => void flushOutbox(store), OUTBOX_POLL_MS);
}

export async function onStopCardService(): Promise<void> {
  clearInterval(outboxTimer);
  outboxTimer = undefined;
  unsubscribeCard?.();
  unsubscribeControl?.();
  unsubscribeCard = undefined;
  unsubscribeControl = undefined;
  channel = undefined;
}

async function flushOutbox(store: QueueStore): Promise<void> {
  if (!channel || channel.state !== 'open') return;
  const events = await store.drainOutbound();
  for (const event of events) {
    try {
      await channel.send(event);
    } catch {
      await store.enqueueOutbound(event); // best-effort — retried next tick
    }
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run apps/tv-vega/src/headless/__tests__/CardService.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Run `check:no-mocks` to confirm this file is still clean**

Run: `npm run check:no-mocks`
Expected: `check:no-mocks — clean`. `__setCardServiceTestDeps` is a DI seam, not an import of anything matching `/mock/i`, so this stays green.

- [ ] **Step 6: Commit**

```bash
git add apps/tv-vega/src/headless/CardService.ts apps/tv-vega/src/headless/__tests__/CardService.test.ts
git commit -m "feat(vega): implement CardService — connect, inbound cards, outbox flush"
```

---

### Task 10: `App.tsx` + `CardRenderer` mount

**Files:**
- Modify: `apps/tv-vega/src/App.tsx`
- Create: `apps/tv-vega/src/pairing/PairingScreen.tsx`
- Test: `apps/tv-vega/src/pairing/__tests__/PairingScreen.test.tsx` — **skipped**, see Step 1 note.

**Interfaces:**
- Consumes: `PairingFlow` (Task 5), `QueueStore` (Task 4), `CardRenderer` (already implemented), `loadDeviceConfig` (Task 4).

- [ ] **Step 1: Note on testing this task**

`App.tsx` is a React component exercising RN-specific primitives (`@amazon-devices/react-native-kepler`'s `View`/`Text`) and effects; `vitest.config.ts`'s `include` is `**/*.{test,spec}.ts` — `.tsx` test files are not picked up, and this repo has no RN component test harness configured (no `@testing-library/react-native`, no jsdom setup visible in `vitest.config.ts`). Adding one is out of scope for this plan. This task is implementation-only, verified by `npm run typecheck:vega` and, per the user's own instruction for this pass, on-device afterward — not by a new automated test. Do not invent a fake harness to force a green checkmark here.

- [ ] **Step 2: Implement `PairingScreen`**

Create `apps/tv-vega/src/pairing/PairingScreen.tsx`:

```tsx
/**
 * Unpaired-device screen. §4.2 steps 1–2: a 6-digit code and a short URL, and
 * nothing else — S4's pairing gate ("unpaired devices show the code and
 * nothing else") already constrains what this may render.
 */
import * as React from 'react';
import { StyleSheet, Text, View } from '@amazon-devices/react-native-kepler';
import { fontSize, safe } from '@wick/vega-calm-ui';
import type { PairingStartResponse } from './PairingFlow.js';

export interface PairingScreenProps {
  readonly info?: PairingStartResponse;
}

export function PairingScreen({ info }: PairingScreenProps): React.JSX.Element {
  return (
    <View style={styles.root}>
      <Text style={styles.headline}>Set up Wick</Text>
      {info ? (
        <>
          <Text style={styles.code}>{info.code}</Text>
          <Text style={styles.body}>Go to {info.url} to finish pairing.</Text>
        </>
      ) : (
        <Text style={styles.body}>Getting a code…</Text>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: safe.ground },
  headline: { fontSize: fontSize('headline'), color: safe.ink, marginBottom: 24 },
  code: { fontSize: fontSize('display'), color: safe.accent, letterSpacing: 8, marginBottom: 16 },
  body: { fontSize: fontSize('body'), color: safe.inkDim },
});
```

Check `packages/vega-calm-ui/src/index.ts` exports `fontSize` and `safe` from `constraints.js` — it currently does `export * from './constraints.js'` only if `constraints.js` is re-exported; confirm by checking `packages/vega-calm-ui/src/index.ts`'s current contents (already read: it exports `tokens.js`, `constraints.js`, `CalmCard.js`, `TwoPhaseCard.js` via `export *`), so `fontSize` and `safe` are already available from `@wick/vega-calm-ui`. No change needed there.

- [ ] **Step 3: Implement `App.tsx`**

Replace `apps/tv-vega/src/App.tsx` entirely:

```tsx
/**
 * Wick — main interactive component (com.wick.tv.main).
 *
 * The device renders and never decides. If you find yourself writing an `if`
 * about *whether* to show something, it belongs in the agent plane.
 * See docs/WICK-TECHNICAL.md §1.1.
 */
// TODO(S2): drive NaturalBreakEngine from PlayerService snapshots.
import * as React from 'react';
import { View } from '@amazon-devices/react-native-kepler';
import KeplerFileSystem from '@amazon-devices/kepler-file-system';
import type { QueuedCard } from '@wick/contracts';
import { CardRenderer } from './cards/CardRenderer.js';
import { PairingFlow, type PairingStartResponse } from './pairing/PairingFlow.js';
import { PairingScreen } from './pairing/PairingScreen.js';
import { QueueStore } from './headless/QueueStore.js';
import { loadDeviceConfig } from './config.js';

const QUEUE_POLL_MS = 1000;
// TODO(S4): use the platform-assigned device id once verified — Appendix A.
const DEVICE_ID = 'wick-tv';

type Screen = { readonly kind: 'pairing'; readonly info?: PairingStartResponse } | { readonly kind: 'ready' };

export default function App(): React.JSX.Element {
  const config = React.useMemo(() => loadDeviceConfig(), []);
  const pairing = React.useMemo(
    () => new PairingFlow({ pairingApiUrl: config.pairingApiUrl }, KeplerFileSystem),
    [config],
  );
  const store = React.useMemo(() => new QueueStore(KeplerFileSystem), []);

  const [screen, setScreen] = React.useState<Screen | null>(null);
  const [card, setCard] = React.useState<QueuedCard | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    (async () => {
      const token = await pairing.loadToken();
      if (cancelled) return;
      if (token) {
        setScreen({ kind: 'ready' });
        return;
      }
      const info = await pairing.start(DEVICE_ID);
      if (cancelled) return;
      setScreen({ kind: 'pairing', info });
      try {
        await pairing.pollUntilBound(info.code);
        if (!cancelled) setScreen({ kind: 'ready' });
      } catch {
        // Left on the pairing screen; a real device would offer a retry
        // affordance here — out of scope for this pass.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [pairing]);

  React.useEffect(() => {
    if (screen?.kind !== 'ready') return;
    let cancelled = false;
    const tick = async () => {
      const cards = await store.readAll();
      const door = cards.find((q) => q.urgency === 'DOOR' && q.card.type === 'DOOR');
      if (!cancelled) setCard(door ?? null);
    };
    void tick();
    const interval = setInterval(() => void tick(), QUEUE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [screen, store]);

  const handleAction = React.useCallback(
    (cardId: string, actionId: string) => {
      void store.remove(cardId);
      setCard(null);
      // The channel lives in the card service process (manifest.toml §3.1);
      // this is how the UI process gets an action back to it — see the
      // plan's Scope decisions.
      void store.enqueueOutbound({ t: 'card_action', cardId, action: actionId, at: Date.now() });
    },
    [store],
  );

  if (!screen) return <View style={{ flex: 1 }} />;
  if (screen.kind === 'pairing') return <PairingScreen info={screen.info} />;

  return <View style={{ flex: 1 }}>{card ? <CardRenderer card={card.card} onAction={handleAction} /> : null}</View>;
}
```

- [ ] **Step 4: Typecheck the app**

Run: `npm run typecheck:vega`
Expected: no errors.

- [ ] **Step 5: Run the full repo verification**

Run: `npm run verify`
Expected: typecheck, typecheck:scripts, lint, check:no-mocks, and the full vitest suite all pass. This is the same command `AGENTS.md` requires before opening a PR — run it once at the end of the whole plan, not just this task, since Tasks 1–9 already ran their own narrower checks.

- [ ] **Step 6: Commit**

```bash
git add apps/tv-vega/src/App.tsx apps/tv-vega/src/pairing/PairingScreen.tsx
git commit -m "feat(vega): mount pairing gate and CardRenderer in App.tsx"
```

---

## After this plan

- Run `npm run verify` once more at the repo root to confirm the whole tree is green.
- Update the "What's next" framing from this session: S1's device loop is now code-complete; the remaining gap to the exit criterion ("a real doorbell press produces a real card on real hardware in <3s, measured") is deployment (`terraform apply` for `infra/pairing.tf` and `infra/transport.tf`, running `infra/bootstrap/generate-pairing-key.sh`, filling in `apps/tv-vega/src/config.ts`'s `DEPLOYED`) and on-hardware verification — both explicitly deferred by the user for this pass.
- `services/agent/src/egress.ts`'s `sendToFamily()` is still a stub (S5 Guardian egress, INV-2's other half) — flagged as priority #2 in the prior conversation, untouched by this plan.
- The MQTT/IoT Core half of SP-5 (Scope decision 2) is a natural next spike once WebSocket infra is deployed and proven: point `MqttChannel` at a real IoT Core endpoint and run the actual 4-hour hardware spike the doc calls for.

/**
 * The Fire OS door service (src/door/doorService.ts): the JavaScript the
 * Android foreground service runs, behind another app. It holds the
 * television's background connection — the WebSocket's `role=background`,
 * exactly as the Vega card service does — and says a door card with a
 * notification. Run here against a stand-in channel and pairing service;
 * the Android half is checked on the emulator (apps/tv-fireos/README.md).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { ControlMessage, QueuedCard } from '@wick/contracts';
import { doorRunner, holdDoor, keptWhose, LANGUAGE_PATH, type DoorAlerts, type DoorHold, type Whose } from '../door/doorService.js';
import type { DoorAlert } from '../door/doorAlert.js';
import { QueueStore, type FileSystemLike } from '../../../tv-vega/src/headless/QueueStore.js';

const CONFIG = { pairingApiUrl: 'https://pair.example', websocketUrl: 'wss://ws.example', wickServerUrl: 'https://wick.example' };
const HOUR = 3_600_000;

function memoryFs(): FileSystemLike & { readonly files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
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

const resident = { jwt: 'resident-jwt', deviceId: 'tv-1', householdId: 'hh-1', expiresAt: Date.now() + HOUR };

/** A television the app has paired: on Fire OS its storage keeps its identity, with a secret, beside the token. */
async function pairedAs(token: object): Promise<ReturnType<typeof memoryFs>> {
  const fs = memoryFs();
  await fs.writeStringToFile('/data/wick-identity.json', JSON.stringify({ deviceId: 'tv-1', proof: 'a'.repeat(64), paired: true }), 'utf8');
  await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(token), 'utf8');
  return fs;
}

/** A channel that hands the test its handlers, and records how it was asked for. */
function standInChannel() {
  const asked: unknown[] = [];
  const cardHandlers = new Set<(c: QueuedCard) => void>();
  const controlHandlers = new Set<(m: ControlMessage) => void>();
  let closed = 0;
  const createChannel = async (config: unknown, token: unknown) => {
    asked.push({ config, token });
    return {
      state: 'open' as const,
      onCard: (h: (c: QueuedCard) => void) => {
        cardHandlers.add(h);
        return () => cardHandlers.delete(h);
      },
      onControl: (h: (m: ControlMessage) => void) => {
        controlHandlers.add(h);
        return () => controlHandlers.delete(h);
      },
      send: async () => undefined,
      connect: async () => undefined,
      close: () => {
        closed += 1;
      },
    };
  };
  return {
    asked,
    createChannel,
    closed: () => closed,
    card: (c: QueuedCard) => cardHandlers.forEach((h) => h(c)),
    control: (m: ControlMessage) => controlHandlers.forEach((h) => h(m)),
  };
}

function recordingAlerts(): DoorAlerts & { readonly shown: DoorAlert[]; readonly cleared: string[] } {
  const shown: DoorAlert[] = [];
  const cleared: string[] = [];
  return {
    shown,
    cleared,
    async show(alert) {
      shown.push(alert);
    },
    async clear(cardId) {
      cleared.push(cardId);
    },
  };
}

const noNetwork = (async () => {
  throw new Error('the pairing service must not be asked');
}) as unknown as typeof fetch;

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

const doorCard = (id = 'door-1', over: object = {}): QueuedCard => ({
  id,
  urgency: 'DOOR',
  card: { type: 'DOOR', id, householdId: 'hh-1', correlationId: 'corr', createdAt: Date.now(), actions: [], line: "Someone's at the front door.", ...over },
  queuedAt: Date.now(),
  expiresAt: Date.now() + 5 * 60_000,
  shownCount: 0,
});

let held: DoorHold | undefined;
afterEach(() => {
  held?.stop();
  held = undefined;
});

describe('the door service on Fire OS', () => {
  it('holds the background connection with the token the app keeps, exactly as the Vega card service does', async () => {
    const channel = standInChannel();
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts: recordingAlerts() });
    await settle();

    expect(channel.asked).toEqual([{ config: { websocket: { url: 'wss://ws.example', role: 'background' } }, token: resident }]);
  });

  it('puts up a heads-up for a door card, and only a quiet one for a note', async () => {
    const channel = standInChannel();
    const alerts = recordingAlerts();
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts });
    await settle();

    channel.card({
      id: 'note-1',
      urgency: 'DEFERRED',
      card: { type: 'MESSAGE', id: 'note-1', householdId: 'hh-1', correlationId: 'c', createdAt: 0, actions: [], fromName: 'Sarah', suggestedReplies: [] },
      queuedAt: Date.now(),
      shownCount: 0,
    });
    channel.card(doorCard());
    await settle();

    expect(alerts.shown).toHaveLength(2);
    expect(alerts.shown).toContainEqual(expect.objectContaining({ cardId: 'note-1', title: 'A note from Sarah is waiting.', quiet: true }));
    const door = alerts.shown.find((a) => a.cardId === 'door-1');
    expect(door).toMatchObject({ title: "Someone's at the front door.", text: 'Open Wick to see who it is.' });
    expect(door?.quiet).toBeUndefined();
  });

  it('says it again, once, with the picture and what the vision model saw when they come', async () => {
    const channel = standInChannel();
    const alerts = recordingAlerts();
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts });
    await settle();

    channel.card(doorCard());
    await settle();
    channel.control({ t: 'patch', patch: { cardId: 'door-1', description: 'A man holding a parcel.', imageRef: 'https://media.example/a.jpg' } });
    await settle();
    // The chime rang: nothing new about who is at the door, so nothing new is said.
    channel.control({ t: 'patch', patch: { cardId: 'door-1', notice: 'The chime rang.' } });
    channel.control({ t: 'patch', patch: { cardId: 'door-1', description: 'A man holding a parcel, waving.' } });
    await settle();

    expect(alerts.shown.map((a) => a.text)).toEqual(['Open Wick to see who it is.', 'A man holding a parcel.']);
    expect(alerts.shown[1]).toMatchObject({ cardId: 'door-1', pictureUrl: 'https://media.example/a.jpg' });
  });

  it('takes the notification down when the card is taken back — answered on another television, or withdrawn', async () => {
    const channel = standInChannel();
    const alerts = recordingAlerts();
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts });
    await settle();

    channel.card(doorCard());
    channel.control({ t: 'revoke', cardId: 'door-1' });
    await settle();

    expect(alerts.cleared).toEqual(['door-1']);
  });

  it('speaks the language the app keeps, read again each time — she may have changed it since the service began', async () => {
    const fs = await pairedAs(resident);
    const channel = standInChannel();
    const alerts = recordingAlerts();
    held = holdDoor({ fs, config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts });
    await settle();

    // The app's own store writes it, where it always has (headless/QueueStore.ts).
    new QueueStore(fs).setHome({ language: 'es' }, { whole: true });
    await settle();
    channel.card(doorCard('door-2', { line: 'Hay alguien en la puerta de entrada.' }));
    await settle();

    expect(alerts.shown).toEqual([expect.objectContaining({ title: 'Hay alguien en la puerta de entrada.', text: 'Abra Wick para ver quién es.', openLabel: 'Abrir Wick' })]);
    expect(fs.files.has(LANGUAGE_PATH)).toBe(true);
  });

  it('writes nothing of the home to the disk the app keeps its cards on', async () => {
    const fs = await pairedAs(resident);
    const before = new Map(fs.files);
    const channel = standInChannel();
    held = holdDoor({ fs, config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts: recordingAlerts() });
    await settle();

    channel.card(doorCard());
    channel.control({ t: 'patch', patch: { cardId: 'door-1', description: 'A man holding a parcel.' } });
    await settle();

    expect(fs.files).toEqual(before);
  });

  it('ends, and the Android service with it, on a television that is not paired', async () => {
    const channel = standInChannel();
    const fetchImpl = (async () => new Response('device_not_paired', { status: 404 })) as unknown as typeof fetch;
    held = holdDoor({ fs: memoryFs(), config: CONFIG, createChannel: channel.createChannel, fetchImpl, alerts: recordingAlerts() });

    await expect(held.done).resolves.toBe('over');
    expect(channel.asked).toEqual([]);
  });

  it("ends on a family member's own television: nothing of the resident's is ever sent to one", async () => {
    const channel = standInChannel();
    held = holdDoor({
      fs: await pairedAs({ ...resident, kind: 'family', userId: 'u-1' }),
      config: CONFIG,
      createChannel: channel.createChannel,
      fetchImpl: noNetwork,
      alerts: recordingAlerts(),
    });

    await expect(held.done).resolves.toBe('over');
    expect(channel.asked).toEqual([]);
  });

  it('lets the connection go when stopped, and ends', async () => {
    const channel = standInChannel();
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts: recordingAlerts() });
    await settle();

    held.stop();

    await expect(held.done).resolves.toBe('over');
    expect(channel.closed()).toBe(1);
  });

  it('a notification that cannot be put up takes nothing down with it', async () => {
    const channel = standInChannel();
    const failing: DoorAlerts = {
      show: async () => {
        throw new Error('notifications are off');
      },
      clear: async () => {
        throw new Error('notifications are off');
      },
    };
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts: failing });
    await settle();

    channel.card(doorCard());
    channel.control({ t: 'revoke', cardId: 'door-1' });
    await settle();

    expect(channel.closed()).toBe(0);
  });
});

describe('the door service across a new pairing', () => {
  /** A hold the test ends, saying whose token it holds. */
  function standInHold(whose: Whose) {
    let end: () => void = () => undefined;
    const done = new Promise<'over' | 'retake'>((resolve) => {
      end = () => resolve('over');
    });
    let stopped = false;
    const hold: DoorHold = {
      done,
      holding: () => (stopped ? undefined : whose),
      stop: () => {
        stopped = true;
        end();
      },
    };
    return hold;
  }

  it('says whose token it holds, once it holds one', async () => {
    const channel = standInChannel();
    held = holdDoor({ fs: await pairedAs(resident), config: CONFIG, createChannel: channel.createChannel, fetchImpl: noNetwork, alerts: recordingAlerts() });
    expect(held.holding()).toBeUndefined();
    await settle();

    expect(held.holding()).toEqual({ deviceId: 'tv-1', householdId: 'hh-1' });
    held.stop();
    expect(held.holding()).toBeUndefined();
  });

  it('is one task for as long as it holds: asked again, it gives the same', () => {
    const holds: DoorHold[] = [];
    const runner = doorRunner(() => {
      const hold = standInHold({ deviceId: 'tv-1', householdId: 'hh-1' });
      holds.push(hold);
      return hold;
    });

    expect(runner.run()).toBe(runner.run());
    expect(holds).toHaveLength(1);
  });

  it('leaves the connection alone while the app holds the same television', async () => {
    const holds: DoorHold[] = [];
    const runner = doorRunner(() => {
      const hold = standInHold({ deviceId: 'tv-1', householdId: 'hh-1' });
      holds.push(hold);
      return hold;
    });
    void runner.run();

    runner.reconsider({ deviceId: 'tv-1', householdId: 'hh-1' });
    await settle();

    expect(holds).toHaveLength(1);
  });

  it('takes the connection up again when the app has been paired again, as a new television — and the task goes on', async () => {
    const whose: Whose[] = [{ deviceId: 'tv-1', householdId: 'hh-1' }, { deviceId: 'tv-2', householdId: 'hh-2' }];
    const holds: DoorHold[] = [];
    const runner = doorRunner(() => {
      const hold = standInHold(whose[holds.length]!);
      holds.push(hold);
      return hold;
    });
    let ended = false;
    void runner.run().then(() => {
      ended = true;
    });

    runner.reconsider({ deviceId: 'tv-2', householdId: 'hh-2' });
    await settle();

    expect(holds).toHaveLength(2);
    expect(holds[1]!.holding()).toEqual({ deviceId: 'tv-2', householdId: 'hh-2' });
    expect(ended).toBe(false);
  });

  it('ends the task when the hold ends by itself, and a later run starts a new one', async () => {
    const holds: DoorHold[] = [];
    const runner = doorRunner(() => {
      const hold = standInHold({ deviceId: 'tv-1', householdId: 'hh-1' });
      holds.push(hold);
      return hold;
    });
    const first = runner.run();

    holds[0]!.stop();
    await expect(first).resolves.toBeUndefined();
    void runner.run();

    expect(holds).toHaveLength(2);
  });
});

/** Channels the test can tell apart: each its own handlers, and whether it was closed. */
function standInChannels() {
  const made: { token: { jwt: string; householdId: string }; card: (c: QueuedCard) => void; closed: boolean; state: 'open' | 'closed' }[] = [];
  const createChannel = async (_config: unknown, token: unknown) => {
    const cards = new Set<(c: QueuedCard) => void>();
    const one = {
      token: token as { jwt: string; householdId: string },
      card: (c: QueuedCard) => cards.forEach((h) => h(c)),
      closed: false,
      state: 'open' as 'open' | 'closed',
    };
    made.push(one);
    return {
      get state() {
        return one.state;
      },
      onCard: (h: (c: QueuedCard) => void) => {
        cards.add(h);
        return () => cards.delete(h);
      },
      onControl: () => () => undefined,
      send: async () => undefined,
      connect: async () => undefined,
      close: () => {
        one.closed = true;
      },
    };
  };
  return { made, createChannel };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('the door service follows the token the app keeps (INV-1, INV-8)', () => {
  it('reads whose television the app holds from its token, and nothing for a family television or none', async () => {
    expect(await keptWhose(await pairedAs(resident))).toEqual({ deviceId: 'tv-1', householdId: 'hh-1' });
    expect(await keptWhose(await pairedAs({ ...resident, kind: 'family', userId: 'u-1' }))).toBeUndefined();
    expect(await keptWhose(memoryFs())).toBeUndefined();
    const torn = memoryFs();
    await torn.writeStringToFile('/data/wick-token.json', '{"jwt":', 'utf8');
    expect(await keptWhose(torn)).toBeUndefined();
  });

  it('with no token kept, lets the connection go, takes its notifications down, and posts nothing more', async () => {
    const fs = await pairedAs(resident);
    const channels = standInChannels();
    const alerts = recordingAlerts();
    held = holdDoor({ fs, config: CONFIG, createChannel: channels.createChannel, fetchImpl: noNetwork, alerts, keptEveryMs: 5 });
    await settle();
    channels.made[0]!.card(doorCard());
    await settle();
    expect(alerts.shown).toHaveLength(1);

    // The family disconnected the television: the app forgets its token (pairing/PairingFlow.ts).
    await fs.writeStringToFile('/data/wick-token.json', '', 'utf8');

    await expect(held.done).resolves.toBe('over');
    expect(held.holding()).toBeUndefined();
    expect(channels.made[0]!.closed).toBe(true);
    expect(alerts.cleared).toEqual(['door-1']);
    channels.made[0]!.card(doorCard('door-2'));
    await settle();
    expect(alerts.shown).toHaveLength(1);
  });

  it("with another home's token kept, takes the connection up again for the new home only", async () => {
    const fs = await pairedAs(resident);
    const channels = standInChannels();
    const alerts = recordingAlerts();
    const runner = doorRunner(() => holdDoor({ fs, config: CONFIG, createChannel: channels.createChannel, fetchImpl: noNetwork, alerts, keptEveryMs: 5 }));
    let ended = false;
    void runner.run().then(() => {
      ended = true;
    });
    await settle();
    channels.made[0]!.card(doorCard('door-old'));
    await settle();

    // Paired again, as a new television, into another home.
    const other = { jwt: 'other-jwt', deviceId: 'tv-2', householdId: 'hh-2', expiresAt: Date.now() + HOUR };
    await fs.writeStringToFile('/data/wick-identity.json', JSON.stringify({ deviceId: 'tv-2', proof: 'b'.repeat(64), paired: true }), 'utf8');
    await fs.writeStringToFile('/data/wick-token.json', JSON.stringify(other), 'utf8');
    await wait(40);

    expect(channels.made.map((c) => c.token.householdId)).toEqual(['hh-1', 'hh-2']);
    expect(channels.made[0]!.closed).toBe(true);
    expect(channels.made[1]!.closed).toBe(false);
    expect(alerts.cleared).toEqual(['door-old']);
    expect(ended).toBe(false);

    channels.made[0]!.card(doorCard('door-stale'));
    channels.made[1]!.card(doorCard('door-new'));
    await settle();
    expect(alerts.shown.map((a) => a.cardId)).toEqual(['door-old', 'door-new']);
    runner.stop();
  });

  it('ends, and takes its notifications down, when the pairing service says the television is no longer connected', async () => {
    const fs = await pairedAs(resident);
    const channels = standInChannels();
    const alerts = recordingAlerts();
    const asked: string[] = [];
    const fetchImpl = (async (url: string) => {
      asked.push(url);
      return new Response('device_not_paired', { status: 404 });
    }) as unknown as typeof fetch;
    held = holdDoor({ fs, config: CONFIG, createChannel: channels.createChannel, fetchImpl, alerts });
    await settle();
    channels.made[0]!.card(doorCard());
    await settle();

    // The edge refuses this television from now on: from here, a connection that is not open.
    channels.made[0]!.state = 'closed';

    await expect(held.done).resolves.toBe('over');
    expect(asked).toEqual(['https://pair.example/pair/refresh']);
    expect(alerts.cleared).toEqual(['door-1']);
    expect(channels.made[0]!.closed).toBe(true);
  });

  it('is stopped outright when Wick is on screen and keeps no token', async () => {
    const fs = await pairedAs(resident);
    const channels = standInChannels();
    const runner = doorRunner(() => holdDoor({ fs, config: CONFIG, createChannel: channels.createChannel, fetchImpl: noNetwork, alerts: recordingAlerts() }));
    const task = runner.run();
    await settle();

    runner.stop();

    await expect(task).resolves.toBeUndefined();
    expect(channels.made[0]!.closed).toBe(true);
  });
});

/**
 * The on-device card queue — inbound cards (upsert/applyPatch/remove) and
 * outbound device events (enqueueOutbound/drainOutbound, flushed by
 * startCardChannel).
 *
 * FL-013: on the VVD, IKeplerFileSystem never provisions a data root for
 * this package, so every call rejects with a bare IoError. A store that only
 * lived on disk lost every card it was handed — the card arrived over the
 * channel and was gone before the UI's next read. So the two halves now
 * degrade differently, according to who shares them:
 *
 *   - The card queue and high-water mark are memory-first. Only the process
 *     holding the channel writes them, and since FL-014 that is the same
 *     process that renders (App.tsx), reading this same instance. Disk is
 *     hydrated once and written through, so a device whose disk works still
 *     survives a restart (§3.4 rule 4) — a disk failure costs persistence
 *     across restarts, never a card in the running app.
 *   - The outbox is genuinely cross-process: RhythmSyncTask runs as its own
 *     task and appends to it for the channel holder to drain. So disk stays
 *     its source of truth whenever disk works, re-read on every drain; only
 *     events the disk refuses fall back to this instance's memory.
 */
import { MAX_CARD_ACTIONS, type CardPatch, type DeviceEvent, type HomeState, type QueuedCard } from '@wick/contracts';

export interface FileSystemLike {
  readFileAsString(path: string, encoding: string): Promise<string>;
  writeStringToFile(path: string, content: string, encoding: string): Promise<number>;
  exists(path: string): Promise<boolean>;
}

// Flat, directly under /data/ — see PairingFlow.ts's TOKEN_PATH comment for
// why (/wick/... failed on-device with a bare com.amazon.kepler.io.IoError).
const QUEUE_PATH = '/data/wick-queue.json';
const OUTBOX_PATH = '/data/wick-outbox.json';
const HIGH_WATER_MARK_PATH = '/data/wick-lastSeenCardId.json';
const ENCODING = 'utf8';

interface State {
  queue: readonly QueuedCard[];
  highWaterMark: string | undefined;
}

export class QueueStore {
  readonly #fs: FileSystemLike;
  readonly #queuePath: string;
  readonly #outboxPath: string;
  readonly #highWaterMarkPath: string;
  #state: Promise<State> | undefined;
  #writes: Promise<unknown> = Promise.resolve();
  /** Outbox read-modify-writes, one at a time, so two quick enqueues can't overwrite each other. */
  #outboxOps: Promise<unknown> = Promise.resolve();
  /** Events the disk refused. Always empty on a device whose disk works. */
  #memoryOutbox: readonly DeviceEvent[] = [];
  #diskFailureLogged = false;
  /**
   * What the home screen says beside its cards (contracts light.ts). Kept
   * in memory only: the server says it afresh each time the television
   * connects, and yesterday's "Sarah looked in" is not worth a disk.
   */
  #home: HomeState = {};

  constructor(
    fs: FileSystemLike,
    queuePath: string = QUEUE_PATH,
    outboxPath: string = OUTBOX_PATH,
    highWaterMarkPath: string = HIGH_WATER_MARK_PATH,
  ) {
    this.#fs = fs;
    this.#queuePath = queuePath;
    this.#outboxPath = outboxPath;
    this.#highWaterMarkPath = highWaterMarkPath;
  }

  readHome(): HomeState {
    return this.#home;
  }

  /** Each part given replaces what was known of it; with `whole`, what is not given is no longer so. */
  setHome(home: HomeState, options: { readonly whole?: boolean } = {}): void {
    this.#home = options.whole ? { ...home } : { ...this.#home, ...home };
  }

  async readAll(): Promise<readonly QueuedCard[]> {
    return (await this.#load()).queue;
  }

  /** Upsert by id — a Phase 2 patch replaces in place, it never duplicates. */
  async upsert(card: QueuedCard): Promise<void> {
    const state = await this.#load();
    state.queue = [...state.queue.filter((c) => c.id !== card.id), card];
    await this.#persist(this.#queuePath, JSON.stringify(state.queue));
    await this.#bumpHighWaterMark(state, card.id);
  }

  async applyPatch(patch: CardPatch): Promise<void> {
    const state = await this.#load();
    state.queue = state.queue.map((q) => {
      if (q.id !== patch.cardId || q.card.type !== 'DOOR') return q;
      return {
        ...q,
        card: {
          ...q.card,
          ...(patch.line === undefined ? {} : { line: patch.line }),
          ...(patch.description === undefined ? {} : { description: patch.description }),
          ...(patch.imageRef === undefined ? {} : { imageRef: patch.imageRef }),
          ...(patch.match === undefined ? {} : { match: patch.match }),
          ...(patch.notice === undefined ? {} : { notice: patch.notice }),
          ...(patch.actions === undefined ? {} : { actions: patch.actions.slice(0, MAX_CARD_ACTIONS) }),
        },
      };
    });
    await this.#persist(this.#queuePath, JSON.stringify(state.queue));
  }

  /**
   * One of a DEFERRED card's two showings is over, unanswered
   * (BreakController.noteShown). Counted here so the engine's "shown twice,
   * never a third time" holds within one sitting; the server counts too,
   * for the next (route.mjs, card-acted.mjs markCardShown).
   */
  async countShowing(cardId: string): Promise<void> {
    const state = await this.#load();
    state.queue = state.queue.map((q) => (q.id === cardId ? { ...q, shownCount: q.shownCount + 1 } : q));
    await this.#persist(this.#queuePath, JSON.stringify(state.queue));
  }

  async remove(cardId: string): Promise<void> {
    const state = await this.#load();
    state.queue = state.queue.filter((c) => c.id !== cardId);
    await this.#persist(this.#queuePath, JSON.stringify(state.queue));
  }

  /**
   * A monotonic high-water mark, tracked independently of the current queue
   * contents — NOT `readAll().at(-1)?.id`. The queue shrinks on remove()
   * (e.g. the resident dismisses a card), and reconcile's contract
   * (route.mjs, INV-6) is "replay everything newer than the last card this
   * device has ever seen." Deriving from the current array would make a
   * dismissed-then-shrunk queue report an older id, causing reconcile to
   * redeliver a card the resident already acted on.
   */
  async lastSeenCardId(): Promise<string | undefined> {
    return (await this.#load()).highWaterMark;
  }

  async #bumpHighWaterMark(state: State, id: string): Promise<void> {
    if (state.highWaterMark !== undefined && state.highWaterMark >= id) return;
    state.highWaterMark = id;
    await this.#persist(this.#highWaterMarkPath, id);
  }

  enqueueOutbound(event: DeviceEvent): Promise<void> {
    return this.#outboxOp(async () => {
      try {
        const onDisk = await this.#readOutboxFromDisk();
        await this.#fs.writeStringToFile(this.#outboxPath, JSON.stringify([...onDisk, event]), ENCODING);
      } catch (err) {
        this.#logDiskFailure('write', err);
        this.#memoryOutbox = [...this.#memoryOutbox, event];
      }
    });
  }

  drainOutbound(): Promise<readonly DeviceEvent[]> {
    return this.#outboxOp(async () => {
      const fromMemory = this.#memoryOutbox;
      this.#memoryOutbox = [];
      let fromDisk: readonly DeviceEvent[] = [];
      try {
        fromDisk = await this.#readOutboxFromDisk();
        if (fromDisk.length > 0) await this.#fs.writeStringToFile(this.#outboxPath, '[]', ENCODING);
      } catch (err) {
        // Read failed: nothing to take from disk. Clear failed after a good
        // read: the events are returned now and may be sent again later — a
        // duplicate, which beats a lost card_action.
        this.#logDiskFailure('read', err);
      }
      return [...fromMemory, ...fromDisk];
    });
  }

  #outboxOp<T>(op: () => Promise<T>): Promise<T> {
    const result = this.#outboxOps.then(op);
    this.#outboxOps = result.catch(() => undefined);
    return result;
  }

  /** Unlike #readRaw, lets a disk failure throw — the outbox needs to know. */
  async #readOutboxFromDisk(): Promise<readonly DeviceEvent[]> {
    if (!(await this.#fs.exists(this.#outboxPath))) return [];
    return parseJsonArray<DeviceEvent>(await this.#fs.readFileAsString(this.#outboxPath, ENCODING));
  }

  /** Hydrates once; every caller before and after shares the same in-memory state. */
  #load(): Promise<State> {
    this.#state ??= (async () => ({
      queue: parseJsonArray<QueuedCard>(await this.#readRaw(this.#queuePath)),
      highWaterMark: (await this.#readRaw(this.#highWaterMarkPath)) || undefined,
    }))();
    return this.#state;
  }

  async #readRaw(path: string): Promise<string> {
    try {
      if (!(await this.#fs.exists(path))) return '';
      return await this.#fs.readFileAsString(path, ENCODING);
    } catch (err) {
      this.#logDiskFailure('read', err);
      return '';
    }
  }

  /**
   * Serialized so two quick changes can't land out of order and leave an
   * older snapshot on disk. Never rejects — see the header.
   */
  #persist(path: string, content: string): Promise<void> {
    const write = this.#writes.then(() => this.#fs.writeStringToFile(path, content, ENCODING));
    this.#writes = write.catch(() => undefined);
    return write.then(
      () => undefined,
      (err: unknown) => this.#logDiskFailure('write', err),
    );
  }

  /** Once per store: on a VVD with no data root this would otherwise log every second. */
  #logDiskFailure(op: 'read' | 'write', err: unknown): void {
    if (this.#diskFailureLogged) return;
    this.#diskFailureLogged = true;
    console.error(`queue_store_disk_${op}_failed — continuing in memory only (FL-013)`, err);
  }
}

function parseJsonArray<T>(raw: string): readonly T[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return []; // a torn write from a previous launch is "nothing persisted", not a crash
  }
}

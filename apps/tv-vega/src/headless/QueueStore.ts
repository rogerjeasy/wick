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

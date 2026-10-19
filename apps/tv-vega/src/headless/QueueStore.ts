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
 *   - The outbox keeps disk as its source of truth whenever disk works,
 *     re-read on every drain, so an event another process appends is sent by
 *     the one that holds the channel (nothing does today: a background task
 *     used to, and was removed as unused); only events the disk refuses fall
 *     back to this instance's memory.
 *
 * Three more things are decided here, because here is where a card comes to
 * be held:
 *
 *   - A card of a kind this build does not know is never kept
 *     (cards/knownCards.ts): not stored, not counted as seen, not read back
 *     from disk. What is not held cannot be picked, shown or take the remote.
 *   - A card sent again takes the place of the one held under its id — the
 *     server does that on every reconcile, and a reconcile is how this
 *     television's cards come to be in her language when she changes it —
 *     and its two showings are neither lost nor counted twice on the way
 *     (upsert, beginShowing, countShowing).
 *   - The language her television speaks (packages/contracts language.ts):
 *     what the home message says, remembered on a disk that works so the
 *     next launch does not begin in English.
 *
 * And one thing is kept here that is never written anywhere: her
 * mantelpiece, as the server last answered (packages/contracts mantel.ts).
 * Each picture in it has an address minted for that one asking, good for an
 * hour — so it lives in this instance's memory and nowhere else.
 */
import {
  DEFAULT_LANGUAGE,
  MAX_CARD_ACTIONS,
  isHouseholdLanguage,
  onThisClock,
  type CardPatch,
  type DeviceEvent,
  type HomeState,
  type HouseholdLanguage,
  type MantelItem,
  type QueuedCard,
} from '@wick/contracts';
import { isKnownCard } from '../cards/knownCards.js';

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
/** Beside the token (pairing/PairingFlow.ts), through the same file system: kept on Fire OS, never on the Vega simulator (FL-013). */
const LANGUAGE_PATH = '/data/wick-language.json';
const ENCODING = 'utf8';

/** Her mantelpiece as the server last answered, and when the answer came (by this television's clock). */
export interface Mantel {
  readonly items: readonly MantelItem[];
  readonly receivedAt: number;
}

interface State {
  queue: readonly QueuedCard[];
  highWaterMark: string | undefined;
}

export class QueueStore {
  readonly #fs: FileSystemLike;
  readonly #queuePath: string;
  readonly #outboxPath: string;
  readonly #highWaterMarkPath: string;
  readonly #languagePath: string;
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
  /**
   * The language this television knows her to have chosen: told by the
   * server since this launch, or remembered from the launch before.
   * Undefined until one or the other — which is not the same as English:
   * being told for the first time is learning it, not a change.
   */
  #language: HouseholdLanguage | undefined;
  /** Whether #language is the server's word, which a remembered one never replaces. */
  #languageTold = false;
  /** What each card's count was when its showing under way began (beginShowing). */
  readonly #showingFrom = new Map<string, number>();
  /** Memory only, on purpose: the addresses in it are written nowhere. */
  #mantel: Mantel | undefined;
  /** Who is listening for the reading she asked for (onSpeech). Nothing of an answer is kept. */
  readonly #speechListeners = new Set<(cardId: string, url: string | undefined) => void>();

  constructor(
    fs: FileSystemLike,
    queuePath: string = QUEUE_PATH,
    outboxPath: string = OUTBOX_PATH,
    highWaterMarkPath: string = HIGH_WATER_MARK_PATH,
    languagePath: string = LANGUAGE_PATH,
  ) {
    this.#fs = fs;
    this.#queuePath = queuePath;
    this.#outboxPath = outboxPath;
    this.#highWaterMarkPath = highWaterMarkPath;
    this.#languagePath = languagePath;
  }

  readHome(): HomeState {
    return this.#home;
  }

  /**
   * Each part given replaces what was known of it; with `whole`, what is not
   * given is no longer so.
   *
   * Says whether her language has just changed: from one this television
   * knew to another. The caller then asks for its cards again
   * (transport/startCardChannel.ts), since the ones it holds are in the
   * old one. A television that knew nothing — just launched, with nothing
   * remembered — is only learning it, and is about to be sent its cards in
   * that language anyway.
   */
  setHome(home: HomeState, options: { readonly whole?: boolean } = {}): { readonly languageChanged: boolean } {
    // Her day, put onto this television's clock as it arrives (contracts today.ts onThisClock): its own may be hours out.
    const told = home.today ? { ...home, today: onThisClock(home.today, Date.now()) } : home;
    this.#home = options.whole ? { ...told } : { ...this.#home, ...told };
    // Only the whole of a home, or a part that names a language, says what the language is.
    if (!options.whole && home.language === undefined) return { languageChanged: false };

    const before = this.#language;
    const now = isHouseholdLanguage(this.#home.language) ? this.#home.language : DEFAULT_LANGUAGE;
    this.#language = now;
    this.#languageTold = true;
    if (now !== before) void this.#persist(this.#languagePath, JSON.stringify(now));
    return { languageChanged: before !== undefined && before !== now };
  }

  /** Her mantelpiece, as the server last answered this television's asking — or nothing, if it has not been asked. */
  readMantel(): Mantel | undefined {
    return this.#mantel;
  }

  /**
   * The whole of it, each time: what is not in the answer is no longer on
   * it. Never persisted. Each answer is later than the one before, even
   * when two come in the same instant or the clock has gone back: when it
   * came is how one answer is told from another (mantel/mantel.ts).
   */
  setMantel(items: readonly MantelItem[], receivedAt: number): void {
    const after = this.#mantel === undefined ? receivedAt : Math.max(receivedAt, this.#mantel.receivedAt + 1);
    this.#mantel = { items: [...items], receivedAt: after };
  }

  /**
   * Read to me (packages/contracts speech.ts): listens for the server's
   * answer to her asking — the card it is for and, when there is something
   * to read, a short-lived address of the reading. Handed over as it comes
   * and kept nowhere: not in memory, not on disk, not in a log. An answer
   * nobody is listening for is simply gone.
   */
  onSpeech(listener: (cardId: string, url: string | undefined) => void): () => void {
    this.#speechListeners.add(listener);
    return () => {
      this.#speechListeners.delete(listener);
    };
  }

  /** The channel's half of it (transport/startCardChannel.ts). */
  heardSpeech(cardId: string, url: string | undefined): void {
    for (const listener of [...this.#speechListeners]) {
      try {
        listener(cardId, url);
      } catch {
        // One listener failing is not the next one's business — and nothing of the answer is logged.
      }
    }
  }

  /**
   * The language her television speaks now: the home's, as last told;
   * before that, the one remembered from the last launch (once the disk has
   * been read — recallLanguage, or any read of the cards); English otherwise.
   */
  language(): HouseholdLanguage {
    return this.#language ?? DEFAULT_LANGUAGE;
  }

  /** The language, once what the last launch remembered has been read. Never rejects: a disk that fails remembers nothing. */
  async recallLanguage(): Promise<HouseholdLanguage> {
    await this.#load();
    return this.language();
  }

  /**
   * Forgets the home. The family has disconnected this television
   * (pairing/standing.ts): her cards, what was about to be told to the
   * server, the last card seen, the language she chose and what the home
   * screen said are a home's, and none of it is this television's to keep
   * — nor the next home's to find. In memory at once, and on disk where
   * there is one. Never rejects: on a disk that cannot be written, nothing
   * was kept.
   */
  async forget(): Promise<void> {
    this.#state = Promise.resolve({ queue: [], highWaterMark: undefined });
    this.#memoryOutbox = [];
    this.#home = {};
    // Her kept pictures and their addresses too (mantel.ts): held in memory only, and never another home's to see.
    this.#mantel = undefined;
    this.#language = undefined;
    this.#languageTold = false;
    this.#showingFrom.clear();
    await Promise.all([this.#persist(this.#queuePath, '[]'), this.#persist(this.#highWaterMarkPath, ''), this.#persist(this.#languagePath, '')]);
    await this.#outboxOp(async () => {
      try {
        await this.#fs.writeStringToFile(this.#outboxPath, '[]', ENCODING);
      } catch (err) {
        this.#logDiskFailure('write', err);
      }
    });
  }

  async readAll(): Promise<readonly QueuedCard[]> {
    return (await this.#load()).queue;
  }

  /**
   * Upsert by id — a Phase 2 patch replaces in place, it never duplicates.
   *
   * A card of a kind this build does not know is not kept at all
   * (cards/knownCards.ts), and does not move the high-water mark: this
   * television has not seen it.
   *
   * The same card sent again — the same `queuedAt`: a reconcile sends a card
   * as it was stored — keeps the larger of the two counts of its showings.
   * The server's is the count of showings begun, this television's of
   * showings ended, so either may be ahead for a moment, and going back to
   * the smaller would show a card a third time. A card asked afresh under an
   * id used before (a new `queuedAt`) starts from the count it comes with.
   */
  async upsert(card: QueuedCard): Promise<void> {
    if (!isKnownCard(card)) return;
    const state = await this.#load();
    const held = state.queue.find((c) => c.id === card.id);
    const again = held !== undefined && held.queuedAt === card.queuedAt;
    if (held && !again) this.#showingFrom.delete(card.id);
    const kept = again && held.shownCount > card.shownCount ? { ...card, shownCount: held.shownCount } : card;
    state.queue = [...state.queue.filter((c) => c.id !== card.id), kept];
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
   *
   * One more than the card's count was when this showing began
   * (beginShowing) — and not one more than it is now: the server counts a
   * showing as it begins, so a card sent again in the middle of one
   * (a reconcile) arrives with this showing already counted.
   */
  async countShowing(cardId: string): Promise<void> {
    const state = await this.#load();
    const from = this.#showingFrom.get(cardId);
    this.#showingFrom.delete(cardId);
    state.queue = state.queue.map((q) =>
      q.id === cardId ? { ...q, shownCount: from === undefined ? q.shownCount + 1 : Math.max(q.shownCount, from + 1) } : q,
    );
    await this.#persist(this.#queuePath, JSON.stringify(state.queue));
  }

  /**
   * A card has just come on screen (BreakController.noteShown's `began`):
   * what its count is now is what the showing is counted from when it ends.
   */
  async beginShowing(cardId: string): Promise<void> {
    const state = await this.#load();
    const card = state.queue.find((q) => q.id === cardId);
    if (card) this.#showingFrom.set(cardId, card.shownCount);
  }

  async remove(cardId: string): Promise<void> {
    const state = await this.#load();
    this.#showingFrom.delete(cardId);
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
    this.#state ??= (async () => {
      const state = {
        // A card left by a newer build, of a kind this one cannot draw, is not read back (cards/knownCards.ts).
        queue: parseJsonArray<unknown>(await this.#readRaw(this.#queuePath)).filter(isKnownCard),
        highWaterMark: (await this.#readRaw(this.#highWaterMarkPath)) || undefined,
      };
      const remembered = parseLanguage(await this.#readRaw(this.#languagePath));
      // The server's word, if it came while the disk was being read, stands.
      if (remembered && !this.#languageTold) this.#language = remembered;
      return state;
    })();
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

/** The language a launch before this one wrote down — or nothing, for anything that is not a language Wick has. */
function parseLanguage(raw: string): HouseholdLanguage | undefined {
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return isHouseholdLanguage(parsed) ? parsed : undefined;
  } catch {
    return undefined;
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

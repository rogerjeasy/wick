/**
 * What `npm run latency:door` decides, apart from how it asks: which message
 * from the edge WebSocket is which step of a door card, how a ring's times
 * are kept, and how they are summed up. Tested with no network
 * (scripts/__tests__/door-latency.test.ts); the asking is
 * scripts/door-latency.ts.
 */

/** One step of a door card arriving on the resident's television. */
export type DoorStep = 'card' | 'picture' | 'description';
export const DOOR_STEPS: readonly DoorStep[] = ['card', 'picture', 'description'];

export interface DoorSignal {
  readonly step: DoorStep;
  readonly cardId: string;
}

const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : undefined;

/**
 * The door steps one wire message carries, read as apps/ops-console/device.js
 * reads them: a `card` message whose card is a DOOR card, and a `patch`
 * control naming a card — with a picture (`imageRef`), a sentence
 * (`description`), or both. Anything else carries none.
 */
export function doorSignals(message: unknown): DoorSignal[] {
  const msg = record(message);
  if (!msg) return [];
  if (msg.kind === 'card') {
    const card = record(record(msg.card)?.card);
    return card?.type === 'DOOR' && typeof card.id === 'string' ? [{ step: 'card', cardId: card.id }] : [];
  }
  const control = record(msg.control);
  if (msg.kind !== 'control' || control?.t !== 'patch') return [];
  const patch = record(control.patch);
  if (!patch || typeof patch.cardId !== 'string') return [];
  const out: DoorSignal[] = [];
  if (typeof patch.imageRef === 'string' && patch.imageRef) out.push({ step: 'picture', cardId: patch.cardId });
  if (typeof patch.description === 'string' && patch.description) out.push({ step: 'description', cardId: patch.cardId });
  return out;
}

/** The Circle card asking the resident about a member (circle.mjs: `circle-<userId>`). */
export function circleCardId(message: unknown, userId: string): string | undefined {
  const msg = record(message);
  const card = msg?.kind === 'card' ? record(record(msg.card)?.card) : undefined;
  return card?.type === 'CIRCLE' && card.id === `circle-${userId}` ? card.id : undefined;
}

/**
 * One ring, timed from the moment its request was sent. The first DOOR card
 * not seen before it is this ring's; the first picture and sentence patched
 * onto that card are its picture and sentence. Times are milliseconds after
 * the request was sent, on this machine's monotonic clock.
 */
export class RingTimer {
  readonly sentAt: number;
  private readonly before: ReadonlySet<string>;
  cardId: string | undefined;
  readonly at: Partial<Record<DoorStep, number>> = {};

  constructor(sentAt: number, cardsSeenBefore: Iterable<string>) {
    this.sentAt = sentAt;
    this.before = new Set(cardsSeenBefore);
  }

  /** Notes a signal that arrived at `now`. */
  note(signal: DoorSignal, now: number): void {
    if (signal.step === 'card') {
      if (this.cardId === undefined && !this.before.has(signal.cardId)) {
        this.cardId = signal.cardId;
        this.at.card = now - this.sentAt;
      }
      return;
    }
    if (signal.cardId === this.cardId && this.at[signal.step] === undefined) this.at[signal.step] = now - this.sentAt;
  }

  /** Every step has come. */
  get complete(): boolean {
    return DOOR_STEPS.every((step) => this.at[step] !== undefined);
  }
}

export interface Summary {
  /** How many rings this step was seen for. */
  readonly n: number;
  readonly median: number | undefined;
  readonly max: number | undefined;
}

export function summarise(samples: readonly number[]): Summary {
  if (samples.length === 0) return { n: 0, median: undefined, max: undefined };
  const sorted = [...samples].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return { n: sorted.length, median, max: sorted[sorted.length - 1]! };
}

/** How long to wait before the next ring, so it falls outside the stand-in doorbell's cooldown. */
export function waitBeforeNextRing(lastSentAt: number | undefined, now: number, cooldownMs: number, marginMs = 1_000): number {
  if (lastSentAt === undefined) return 0;
  return Math.max(0, lastSentAt + cooldownMs + marginMs - now);
}

/** The pairing service and the edge WebSocket, as the deployed browser television names them (device.js). */
export function edgeUrlsIn(deviceJs: string): { pairing: string | undefined; websocket: string | undefined } {
  const constant = (name: string) => new RegExp(`^const ${name} = '([^']+)';`, 'm').exec(deviceJs)?.[1];
  const real = (value: string | undefined) => (value && !value.endsWith('_PLACEHOLDER') ? value : undefined);
  return { pairing: real(constant('PAIRING_API_URL')), websocket: real(constant('WEBSOCKET_URL')) };
}

/** "1.234 s", or "not seen". */
export const seconds = (ms: number | undefined): string => (ms === undefined ? 'not seen' : `${(ms / 1000).toFixed(2)} s`);

/**
 * The door says on the bus that it rang: `door.rang` from `wick.door`
 * (packages/contracts errand.ts), for every ring, a Ring doorbell's and a
 * demo home's stand-in alike. A visit errand waiting at the door hears it
 * (agents/errand/door.ts, by its own rule in infra/errands.tf).
 *
 * What it carries is when, which card, the household and who the card said
 * it looks like — never the picture, the sentence or a Ring id. It is put
 * after the card is on its way, and is best-effort: route.ts logs a failure
 * and goes on, so it never delays or costs her the card.
 *
 * Pure but for the one call handed in; lambda.ts owns the client.
 */
import { ERRAND_EVENTS, type DoorRangDetail } from '@wick/contracts';

export interface DoorRangEntry {
  readonly EventBusName: string;
  readonly Source: string;
  readonly DetailType: string;
  readonly Detail: string;
}

/** EventBridge's PutEvents, as much of it as this needs. */
export type PutEntries = (entries: readonly DoorRangEntry[]) => Promise<{ readonly FailedEntryCount?: number | undefined }>;

export function doorRangEntry(busName: string, detail: DoorRangDetail): DoorRangEntry {
  return { EventBusName: busName, Source: ERRAND_EVENTS.source, DetailType: ERRAND_EVENTS.doorRang, Detail: JSON.stringify(detail) };
}

/** Says each ring on `busName`; nothing at all where no bus is named. */
export function announceRings(put: PutEntries, busName: string | undefined): (detail: DoorRangDetail) => Promise<void> {
  return async (detail) => {
    if (!busName) return;
    const res = await put([doorRangEntry(busName, detail)]);
    if (res.FailedEntryCount) throw new Error('door.rang was not put');
  };
}

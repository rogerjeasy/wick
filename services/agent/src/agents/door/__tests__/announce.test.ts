/**
 * The door says on the bus that it rang (door.rang), for whatever is waiting
 * for a ring — a visit errand (agents/errand/door.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { ERRAND_EVENTS, readDoorRangDetail } from '@wick/contracts';
import { announceRings, doorRangEntry, type PutEntries } from '../announce.js';

const DETAIL = { householdId: 'hh-1', at: 1_791_968_640_000, cardId: 'door-abc', matchPersonId: 'errand:err_AAAAAAAAAAAAAAAAAAAA' };

describe('doorRangEntry — one entry for the Wick bus', () => {
  it('is the wick.door source and door.rang detail-type the errand rule passes, with a detail the reader takes', () => {
    const entry = doorRangEntry('wick', DETAIL);

    expect(entry).toEqual({ EventBusName: 'wick', Source: ERRAND_EVENTS.source, DetailType: ERRAND_EVENTS.doorRang, Detail: JSON.stringify(DETAIL) });
    expect(readDoorRangDetail(JSON.parse(entry.Detail))).toEqual(DETAIL);
  });

  it('carries no picture, no sentence and no Ring id: when, which card, and who it looked like', () => {
    expect(Object.keys(JSON.parse(doorRangEntry('wick', DETAIL).Detail)).sort()).toEqual(['at', 'cardId', 'householdId', 'matchPersonId']);
  });
});

describe('announceRings', () => {
  it('puts the entry on the bus it was given', async () => {
    const put = vi.fn<PutEntries>(async () => ({ FailedEntryCount: 0 }));

    await announceRings(put, 'wick')(DETAIL);

    expect(put).toHaveBeenCalledWith([doorRangEntry('wick', DETAIL)]);
  });

  it('fails when EventBridge says the entry was not put, so the door logs it', async () => {
    await expect(announceRings(async () => ({ FailedEntryCount: 1 }), 'wick')(DETAIL)).rejects.toThrow('door.rang was not put');
  });

  it('does nothing where no bus is named: a laptop, a test', async () => {
    const put = vi.fn<PutEntries>(async () => ({}));
    await announceRings(put, undefined)(DETAIL);
    expect(put).not.toHaveBeenCalled();
  });
});

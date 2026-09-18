import { describe, it, expect } from 'vitest';
import { DEFAULT_POLICY } from '@wick/policy';
import type { EgressItem } from '../egress.js';
import { sendToFamily } from '../egress.js';

const item = (overrides: Partial<EgressItem> = {}): EgressItem => ({
  class: 'DOOR_EVENT',
  content: 'A parcel arrived at the front door.',
  sourceIds: ['evt-1'],
  correlationId: 'corr-1',
  ...overrides,
});

describe('sendToFamily', () => {
  it('sends untransformed content straight through when the policy allows it with no transform', async () => {
    const result = await sendToFamily(item({ class: 'DOOR_EVENT' }), 'FAMILY', DEFAULT_POLICY);
    expect(result).toEqual({ sent: true, content: 'A parcel arrived at the front door.' });
  });

  it('refuses outright when the policy denies the class to this audience', async () => {
    const result = await sendToFamily(item({ class: 'HEALTH' }), 'FAMILY', DEFAULT_POLICY);
    expect(result.sent).toBe(false);
  });

  it("refuses VERBATIM to FAMILY unconditionally — INV-4, no policy override reaches this", async () => {
    const result = await sendToFamily(item({ class: 'VERBATIM' }), 'FAMILY', DEFAULT_POLICY);
    expect(result.sent).toBe(false);
  });

  it('fails closed on a class the policy requires a transform for, rather than sending raw content or inventing one — RHYTHM/COMMITMENT need "summarise", which is not implemented', async () => {
    const result = await sendToFamily(item({ class: 'COMMITMENT' }), 'FAMILY', DEFAULT_POLICY);
    expect(result.sent).toBe(false);
  });

  it('the RHYTHM refusal is the same fail-closed path — never leak raw content because the transform is missing', async () => {
    const result = await sendToFamily(item({ class: 'RHYTHM' }), 'FAMILY', DEFAULT_POLICY);
    expect(result.sent).toBe(false);
  });

  it('an AGENCY audience gets its own-visits classes with no transform needed', async () => {
    const result = await sendToFamily(item({ class: 'DOOR_EVENT' }), 'AGENCY', DEFAULT_POLICY);
    expect(result).toEqual({ sent: true, content: 'A parcel arrived at the front door.' });
  });

  it('never throws for a well-formed item — a refusal is a value, not an exception', async () => {
    await expect(sendToFamily(item({ class: 'COMMITMENT' }), 'FAMILY', DEFAULT_POLICY)).resolves.toBeDefined();
  });
});

import { describe, it, expect, vi } from 'vitest';
import type { CardPatch } from '@wick/contracts';
import { RingApiError, type RingImage } from '@wick/ring';
import { runDoorPhase2 } from '../phase2.js';
import type { DescribeResult } from '../describe.js';

const image: RingImage = {
  url: 'https://download-eu-south-2.prod.phoenix.devices.amazon.dev/x',
  capturedAt: 1789455093305,
  fetchedAt: 1789455097000,
};
const bytes = new Uint8Array([1, 2, 3]);

const okDescribe: DescribeResult = {
  candidate: { description: 'A man in a delivery uniform, holding a parcel.', confidence: 0.9 },
  reason: 'ok',
  elapsedMs: 1200,
};

describe('runDoorPhase2', () => {
  it('sends the image patch as soon as the image arrives', async () => {
    const sendPatch = vi.fn(async (_p: CardPatch) => {});
    const fetchImage = vi.fn(async () => ({ image, bytes }));
    const describeFn = vi.fn(async () => okDescribe);

    await runDoorPhase2('card-1', { fetchImage, describe: describeFn, sendPatch });

    expect(sendPatch).toHaveBeenCalledWith(expect.objectContaining({ cardId: 'card-1', imageRef: image.url }));
  });

  it('describes the fetched bytes and sends the description patch when it validates', async () => {
    const sendPatch = vi.fn(async (_p: CardPatch) => {});
    const fetchImage = vi.fn(async () => ({ image, bytes }));
    const describeFn = vi.fn(async (b: Uint8Array) => {
      expect(b).toBe(bytes);
      return okDescribe;
    });

    await runDoorPhase2('card-1', { fetchImage, describe: describeFn, sendPatch });

    expect(sendPatch).toHaveBeenCalledWith(
      expect.objectContaining({ cardId: 'card-1', description: okDescribe.candidate!.description }),
    );
    expect(sendPatch).toHaveBeenCalledTimes(2);
  });

  it('sends only the image patch when the model declines — Phase 1 stands (Principle 11)', async () => {
    const sendPatch = vi.fn(async (_p: CardPatch) => {});
    const fetchImage = vi.fn(async () => ({ image, bytes }));
    const declined: DescribeResult = { candidate: null, reason: 'model declined: unclear frame', elapsedMs: 400 };
    const describeFn = vi.fn(async () => declined);

    await runDoorPhase2('card-1', { fetchImage, describe: describeFn, sendPatch });

    expect(sendPatch).toHaveBeenCalledTimes(1);
    expect(sendPatch).toHaveBeenCalledWith(expect.objectContaining({ imageRef: image.url }));
  });

  it('sends only the image patch when the candidate fails validation (buildDescriptionPatch)', async () => {
    const sendPatch = vi.fn(async (_p: CardPatch) => {});
    const fetchImage = vi.fn(async () => ({ image, bytes }));
    const lowConfidence: DescribeResult = {
      candidate: { description: 'A man in a delivery uniform, holding a parcel.', confidence: 0.1 },
      reason: 'ok',
      elapsedMs: 900,
    };
    const describeFn = vi.fn(async () => lowConfidence);

    await runDoorPhase2('card-1', { fetchImage, describe: describeFn, sendPatch });

    expect(sendPatch).toHaveBeenCalledTimes(1);
  });

  it('sends nothing and never calls describe when the image fetch fails entirely', async () => {
    const sendPatch = vi.fn(async (_p: CardPatch) => {});
    const fetchImage = vi.fn(async () => {
      throw new Error('ring_api_500');
    });
    const describeFn = vi.fn(async () => okDescribe);

    await expect(runDoorPhase2('card-1', { fetchImage, describe: describeFn, sendPatch })).resolves.toEqual({
      image: 'unavailable',
      description: 'skipped',
      reason: 'ring_api_500',
    });

    expect(describeFn).not.toHaveBeenCalled();
    expect(sendPatch).not.toHaveBeenCalled();
  });

  it('still attempts the description patch when sending the image patch fails', async () => {
    const sendPatch = vi.fn(async (patch: CardPatch) => {
      if (patch.imageRef) throw new Error('ddb_down');
    });
    const fetchImage = vi.fn(async () => ({ image, bytes }));
    const describeFn = vi.fn(async () => okDescribe);

    await expect(
      runDoorPhase2('card-1', { fetchImage, describe: describeFn, sendPatch }),
    ).resolves.toMatchObject({ image: 'patch_failed', description: 'patched' });

    expect(sendPatch).toHaveBeenCalledWith(expect.objectContaining({ description: expect.any(String) }));
  });

  it('corrects the headline from the event type when the frame shows nobody', async () => {
    const sendPatch = vi.fn(async (_p: CardPatch) => {});
    const nobody: DescribeResult = {
      candidate: { description: 'Three cars parked in a parking lot.', confidence: 0.9, personVisible: false },
      reason: 'ok',
      elapsedMs: 800,
    };

    await runDoorPhase2('card-1', { fetchImage: async () => ({ image, bytes }), describe: async () => nobody, sendPatch }, 'button_press');

    expect(sendPatch).toHaveBeenCalledWith(expect.objectContaining({ line: 'The doorbell rang.' }));
  });

  describe('reports what happened, so a Phase 2 that stops early is never silent', () => {
    it('names Ring\'s own reason when there is no recorded frame for the event', async () => {
      // Observed live: a webhook whose occurred_at has no recording behind it.
      const fetchImage = vi.fn(async () => {
        throw new RingApiError(416, 'MEDIA_NOT_FOUND', 'No media found in time range 1790805194905-1790805204905');
      });

      const outcome = await runDoorPhase2('card-1', { fetchImage, describe: vi.fn(), sendPatch: vi.fn() });

      expect(outcome).toEqual({
        image: 'unavailable',
        description: 'skipped',
        reason: 'ring_api_416_MEDIA_NOT_FOUND: No media found in time range 1790805194905-1790805204905',
      });
    });

    it('reports both patches on the happy path', async () => {
      const outcome = await runDoorPhase2('card-1', {
        fetchImage: async () => ({ image, bytes }),
        describe: async () => okDescribe,
        sendPatch: async () => {},
      });

      expect(outcome).toEqual({ image: 'patched', description: 'patched', reason: 'ok' });
    });

    it('carries the model\'s reason when it declines', async () => {
      const outcome = await runDoorPhase2('card-1', {
        fetchImage: async () => ({ image, bytes }),
        describe: async () => ({ candidate: null, reason: 'model declined: unclear frame', elapsedMs: 400 }),
        sendPatch: async () => {},
      });

      expect(outcome).toEqual({ image: 'patched', description: 'declined', reason: 'model declined: unclear frame' });
    });

    it('says the description was not shown when the candidate fails validation', async () => {
      const outcome = await runDoorPhase2('card-1', {
        fetchImage: async () => ({ image, bytes }),
        describe: async () => ({
          candidate: { description: 'A man in a delivery uniform, holding a parcel.', confidence: 0.1 },
          reason: 'ok',
          elapsedMs: 900,
        }),
        sendPatch: async () => {},
      });

      expect(outcome).toMatchObject({ image: 'patched', description: 'rejected' });
    });
  });
});

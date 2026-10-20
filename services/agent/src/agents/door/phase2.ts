/**
 * Phase 2 — the picture, then the sentence. §5.2, §9.1.
 *
 * Runs after Phase 1 has already reached the device, so nothing here may
 * regress the card the resident already has. `describeFrame` (describe.ts)
 * carries its own hard cancel (DESCRIBE_TIMEOUT_MS) and never throws — this
 * module's only job is sequencing: fetch the image, patch it in, describe
 * it, patch the sentence in if the model produced one worth showing. A
 * failed patch SEND is swallowed rather than propagated, so a DynamoDB
 * hiccup on the image patch can't cost the description patch too.
 *
 * A failed image FETCH is different: no bytes means no description is
 * possible either, so that one short-circuits the rest of Phase 2 — Phase 1
 * simply stands, which the product doc is explicit is still useful.
 *
 * Swallowed is not the same as silent: every run returns a Phase2Outcome
 * naming what landed and why the rest didn't, and lambda.ts logs it. It used
 * to return nothing — a card that never got its picture (Ring's own
 * `416 MEDIA_NOT_FOUND`, observed live) left no trace anywhere.
 */
import type { CardPatch } from '@wick/contracts';
import { RingApiError, type RingImage } from '@wick/ring';
import { buildDescriptionPatch, buildImagePatch } from './index.js';
import type { DescribeResult } from './describe.js';

export interface Phase2Deps {
  readonly fetchImage: () => Promise<{ readonly image: RingImage; readonly bytes: Uint8Array }>;
  readonly describe: (bytes: Uint8Array) => Promise<DescribeResult>;
  readonly sendPatch: (patch: CardPatch) => Promise<void>;
}

export interface Phase2Outcome {
  readonly image: 'patched' | 'patch_failed' | 'unavailable';
  /** `rejected`: the model answered, but buildDescriptionPatch refused to show it. */
  readonly description: 'patched' | 'patch_failed' | 'declined' | 'rejected' | 'skipped';
  readonly reason: string;
}

/** Swallowed on purpose — see module comment. Reports whether it landed. */
async function trySend(deps: Phase2Deps, patch: CardPatch): Promise<boolean> {
  try {
    await deps.sendPatch(patch);
    return true;
  } catch {
    return false;
  }
}

function describeError(err: unknown): string {
  if (err instanceof RingApiError && err.detail) return `${err.message}: ${err.detail}`;
  return err instanceof Error ? err.message : String(err);
}

/**
 * `work`, or a failure named `reason` once `ms` have passed — whichever is
 * first. The frame is a retry loop over Ring calls (FL-008), each with its
 * own deadline but not the loop as a whole; this bounds the whole, so
 * Phase 2 always ends inside the door Lambda's timeout (infra/agent.tf).
 * What is still in flight at the deadline ends at its own.
 */
export function withinDeadline<T>(work: () => Promise<T>, ms: number, reason: string): () => Promise<T> {
  return () => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(reason)), ms);
    });
    return Promise.race([work(), deadline]).finally(() => clearTimeout(timer));
  };
}

/** What Phase 1 settled that Phase 2 must leave as it is. */
export interface Phase2Options {
  /** The headline is the visitor's own confirmation (index.ts buildPhaseOneCard): the frame may describe, never correct it. */
  readonly keepLine?: boolean;
}

/** `eventType` picks the corrected headline when the frame shows nobody (index.ts). */
export async function runDoorPhase2(
  cardId: string,
  deps: Phase2Deps,
  eventType?: string,
  options: Phase2Options = {},
): Promise<Phase2Outcome> {
  let image: RingImage;
  let bytes: Uint8Array;
  try {
    ({ image, bytes } = await deps.fetchImage());
  } catch (err) {
    return { image: 'unavailable', description: 'skipped', reason: describeError(err) };
  }

  const imageOutcome = (await trySend(deps, buildImagePatch(cardId, image))) ? 'patched' : 'patch_failed';

  const described = await deps.describe(bytes);
  if (!described.candidate) return { image: imageOutcome, description: 'declined', reason: described.reason };

  const patch = buildDescriptionPatch(cardId, described.candidate, eventType, options);
  if (!patch) return { image: imageOutcome, description: 'rejected', reason: described.reason };

  const descriptionOutcome = (await trySend(deps, patch)) ? 'patched' : 'patch_failed';
  return { image: imageOutcome, description: descriptionOutcome, reason: described.reason };
}

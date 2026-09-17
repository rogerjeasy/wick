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
 */
import type { CardPatch } from '@wick/contracts';
import type { RingImage } from '@wick/ring';
import { buildDescriptionPatch, buildImagePatch } from './index.js';
import type { DescribeResult } from './describe.js';

export interface Phase2Deps {
  readonly fetchImage: () => Promise<{ readonly image: RingImage; readonly bytes: Uint8Array }>;
  readonly describe: (bytes: Uint8Array) => Promise<DescribeResult>;
  readonly sendPatch: (patch: CardPatch) => Promise<void>;
}

async function trySend(deps: Phase2Deps, patch: CardPatch): Promise<void> {
  try {
    await deps.sendPatch(patch);
  } catch {
    // Swallowed on purpose — see module comment.
  }
}

export async function runDoorPhase2(cardId: string, deps: Phase2Deps): Promise<void> {
  let image: RingImage;
  let bytes: Uint8Array;
  try {
    ({ image, bytes } = await deps.fetchImage());
  } catch {
    return;
  }

  await trySend(deps, buildImagePatch(cardId, image));

  const described = await deps.describe(bytes);
  const patch = described.candidate ? buildDescriptionPatch(cardId, described.candidate) : null;
  if (patch) await trySend(deps, patch);
}

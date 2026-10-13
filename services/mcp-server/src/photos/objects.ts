/**
 * Where a picture's bytes are kept: the photos bucket, written to and
 * never read from here.
 *
 * This server puts a picture there when it is sent, and takes it away
 * again only to undo a sending that failed. It never gets an object, never
 * asks whether one exists, and never reads or changes a tag: whether she
 * kept a picture is told by none of those to anyone, because nothing here
 * can ask (packages/contracts mantel.ts, THE RULE). The address her
 * television is given is minted on the way to it, by the egress; the tag
 * is changed, when she keeps one, by the edge.
 *
 * `send` is an S3Client's send, injected so the exact requests are tested
 * without AWS — the same seam as accounts/store.ts.
 */
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PHOTO_STATES, PHOTO_STATE_TAG, photoObjectKey } from '@wick/contracts';

export type S3Send = (command: PutObjectCommand | DeleteObjectCommand) => Promise<unknown>;

/**
 * The tag a picture is stored with: the contract's one tag, in its first
 * state. The bucket's lifecycle goes by it — sent, and not (yet) kept — and
 * an object with no tag would never be let go of. This server writes it
 * once, here, and never reads or changes it: what it becomes is the edge's
 * to write, at her press.
 */
export const PHOTO_OBJECT_TAGGING = `${PHOTO_STATE_TAG}=${PHOTO_STATES.sent}`;

export interface PhotoObjects {
  /** Stores a picture. Throws rather than write over one already there. */
  put(householdId: string, photoId: string, bytes: Uint8Array): Promise<void>;
  /** Takes away a picture this server has just put: only ever the undoing of a sending that failed. */
  remove(householdId: string, photoId: string): Promise<void>;
}

export function createS3PhotoObjects(send: S3Send, bucket: string): PhotoObjects {
  return {
    async put(householdId, photoId, bytes) {
      await send(new PutObjectCommand({
        Bucket: bucket,
        // Built only from the household in the sender's own token and an id that is a picture's (INV-8).
        Key: photoObjectKey(householdId, photoId),
        Body: bytes,
        ContentType: 'image/jpeg',
        Tagging: PHOTO_OBJECT_TAGGING,
        // Never over an object that is there: a picture she has kept cannot be changed under her.
        IfNoneMatch: '*',
      }));
    },
    async remove(householdId, photoId) {
      await send(new DeleteObjectCommand({ Bucket: bucket, Key: photoObjectKey(householdId, photoId) }));
    },
  };
}

import { describe, expect, it } from 'vitest';
import { DeleteObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { PHOTO_STATES, PHOTO_STATE_TAG } from '@wick/contracts';
import { PHOTO_OBJECT_TAGGING, createS3PhotoObjects, type S3Send } from '../objects.js';

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);

function recorder(replies: (Error | object)[] = []) {
  const sent: (PutObjectCommand | DeleteObjectCommand)[] = [];
  const send = (async (command: PutObjectCommand | DeleteObjectCommand) => {
    sent.push(command);
    const reply = replies.shift() ?? {};
    if (reply instanceof Error) throw reply;
    return reply;
  }) as S3Send;
  return { sent, objects: createS3PhotoObjects(send, 'wick-photos-test') };
}

describe('the photos bucket — where a picture’s bytes are kept', () => {
  it('puts a picture under its household and id, as a JPEG, tagged as sent, and never over one that is there', async () => {
    const { sent, objects } = recorder();

    await objects.put('hh_1', 'abc123', BYTES);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toBeInstanceOf(PutObjectCommand);
    expect(sent[0]!.input).toEqual({
      Bucket: 'wick-photos-test',
      Key: 'photos/hh_1/abc123.jpg',
      Body: BYTES,
      ContentType: 'image/jpeg',
      // What the bucket's lifecycle rules key on: sent, and not (yet) kept.
      Tagging: 'state=sent',
      IfNoneMatch: '*',
    });
    expect(PHOTO_OBJECT_TAGGING).toBe('state=sent');
    // The contract's own tag and state (packages/contracts mantel.ts), which the bucket's lifecycle and the edge go by.
    expect(PHOTO_OBJECT_TAGGING).toBe(`${PHOTO_STATE_TAG}=${PHOTO_STATES.sent}`);
  });

  it('removes exactly that object', async () => {
    const { sent, objects } = recorder();

    await objects.remove('hh_1', 'abc123');

    expect(sent[0]).toBeInstanceOf(DeleteObjectCommand);
    expect(sent[0]!.input).toEqual({ Bucket: 'wick-photos-test', Key: 'photos/hh_1/abc123.jpg' });
  });

  it('lets a failure be a failure: the sending decides what to undo', async () => {
    const { objects } = recorder([Object.assign(new Error('no'), { name: 'PreconditionFailed' })]);

    await expect(objects.put('hh_1', 'abc123', BYTES)).rejects.toMatchObject({ name: 'PreconditionFailed' });
  });
});

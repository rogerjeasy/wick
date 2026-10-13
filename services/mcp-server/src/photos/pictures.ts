/**
 * What a member is told of the pictures they sent: for each, that it is
 * waiting on her television, or that she has seen it. One thing, whichever
 * button she pressed (packages/contracts mantel.ts, THE RULE): kept, not
 * kept and taken down a week later read exactly the same here, because
 * this reads the picture's own row and nothing else — and that row says
 * only that it was seen.
 *
 * A member's own pictures and nobody else's, the organiser no more than
 * anyone: what somebody sent her is between the two of them.
 */
import type { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { photoSeenText } from '@wick/contracts';
import { listPhotos } from './rows.js';

/** How far back the list goes, and how long it can be. */
export const PICTURES_WINDOW_MS = 7 * 24 * 60 * 60_000;
export const MAX_PICTURES = 10;

/** Said of a picture she has not pressed anything on yet. */
export const photoWaitingText = (residentName: string): string => `It is waiting on ${residentName}’s television.`;

export interface SentPicture {
  readonly photoId: string;
  readonly sentAt: number;
  readonly seen: boolean;
  readonly say: string;
}

export async function loadSentPictures(
  ddb: DynamoDBClient,
  who: { readonly householdId: string; readonly userId: string },
  residentName: string,
  now: number,
): Promise<SentPicture[]> {
  return (await listPhotos(ddb, who.householdId))
    .filter((row) => row.sentBy === who.userId && row.sentAt > now - PICTURES_WINDOW_MS)
    .sort((a, b) => b.sentAt - a.sentAt || b.photoId.localeCompare(a.photoId))
    .slice(0, MAX_PICTURES)
    .map((row) => ({
      photoId: row.photoId,
      sentAt: row.sentAt,
      seen: row.seen,
      say: row.seen ? photoSeenText(residentName) : photoWaitingText(residentName),
    }));
}

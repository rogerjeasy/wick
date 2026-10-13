/**
 * What waits for a family member, said while Wick is off the screen of
 * their own television (packages/contracts/src/familyTelevision.ts
 * `FamilyTvWaiting`). Posted by the background service
 * (headless/waitingService.ts), once for each thing.
 *
 * The title is the server's sentence, as it stands. The line under it and
 * the button are the television's own, and say only where to answer. There
 * is no picture and nothing of the resident's day in it: the server sends
 * the service a sentence and nothing else.
 *
 * The same shape, channel name and launch target as the door's toast on
 * the resident's television (notify/doorToast.ts `wickToast`, FL-022).
 */
import type { FamilyTvWaiting } from '@wick/contracts';
import { MAX_NOTIFICATION_BYTES, WICK_ICON_URL, notificationBytes, wickToast, type ToastContent } from './doorToast.js';

const WHERE_TO_ANSWER = 'Open Wick to answer.';

/** The toast for one thing that waits — or nothing, for one the platform would refuse for its size. */
export function waitingToast(waiting: FamilyTvWaiting['waiting'][number]): ToastContent | undefined {
  const toast = wickToast(waiting.line, WHERE_TO_ANSWER, WICK_ICON_URL);
  return notificationBytes(toast) <= MAX_NOTIFICATION_BYTES ? toast : undefined;
}

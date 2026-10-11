/**
 * A nudge to the family's own browsers (Web Push): there is something to
 * open Wick for. See packages/contracts push.ts for what is sent — a kind,
 * and nothing about the house.
 *
 * Pure of AWS and of the network: who to nudge, which addresses may be
 * called, and what a push service's answer means are decided here and
 * tested here. egress.ts hands in the table and the one function that
 * makes the request (INV-2).
 *
 * It never throws. A nudge is a courtesy on top of something already done —
 * the question is filed and the resident has been told — and a browser that
 * cannot be reached must not undo either.
 */
import type { AttributeValue } from '@aws-sdk/client-dynamodb';
import { isPushServiceUrl, type PushKind } from '@wick/contracts';

/** One browser that asked to be told. */
export interface StoredSubscription {
  readonly sk: string;
  readonly endpoint: string;
  /** The browser's public key and secret: what the payload is encrypted to (RFC 8291). */
  readonly p256dh: string;
  readonly auth: string;
}

export interface NudgeDeps {
  readonly listSubscriptions: (userId: string) => Promise<readonly StoredSubscription[]>;
  /** Makes the request; answers with the push service's HTTP status. */
  readonly post: (subscription: StoredSubscription, payload: string) => Promise<number>;
  readonly forget: (userId: string, sk: string) => Promise<void>;
}

export interface NudgeOutcome {
  readonly sent: number;
  /** Browsers the push service no longer knows; their rows are removed. */
  readonly gone: number;
  readonly failed: number;
}

export function subscriptionFromItem(item: Record<string, AttributeValue>): StoredSubscription | undefined {
  const sk = item.sk?.S;
  const endpoint = item.endpoint?.S;
  const p256dh = item.p256dh?.S;
  const auth = item.auth?.S;
  return sk && endpoint && p256dh && auth ? { sk, endpoint, p256dh, auth } : undefined;
}

/** 404 and 410 are the push services' way of saying a subscription has ended (RFC 8030 §7.3). */
const isGone = (status: number): boolean => status === 404 || status === 410;

export async function nudge(userIds: readonly string[], kind: PushKind, deps: NudgeDeps): Promise<NudgeOutcome> {
  const payload = JSON.stringify({ kind });
  let sent = 0;
  let gone = 0;
  let failed = 0;

  await Promise.all([...new Set(userIds)].map(async (userId) => {
    let subscriptions: readonly StoredSubscription[];
    try {
      subscriptions = await deps.listSubscriptions(userId);
    } catch {
      failed += 1;
      return;
    }
    await Promise.all(subscriptions.map(async (subscription) => {
      // Checked when it was stored (the Wick server's accounts/push.ts), and
      // again here: this is the request, and a row is only a row.
      if (!isPushServiceUrl(subscription.endpoint)) {
        failed += 1;
        return;
      }
      try {
        const status = await deps.post(subscription, payload);
        if (status >= 200 && status < 300) {
          sent += 1;
        } else if (isGone(status)) {
          gone += 1;
          await deps.forget(userId, subscription.sk);
        } else {
          failed += 1;
        }
      } catch {
        failed += 1;
      }
    }));
  }));

  return { sent, gone, failed };
}

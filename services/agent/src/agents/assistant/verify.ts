/**
 * Whose a token is, asked of the Wick server — before a conversation is
 * opened.
 *
 * The runtime is shared: the door, card-action and brief Lambdas may invoke
 * it as well as the Wick server. So a payload's `householdId` and `memberId`
 * are only a claim. Which conversation is restored, and which member's words
 * are read and written, must follow from the token, or a caller with any
 * token could name somebody else's ids and be answered from their saved
 * conversation — tool results about the resident included — without a tool
 * call that checks anything.
 *
 * So the turn first asks the Wick server's GET /api/me with the token
 * (INV-8: the server reads the person and the household from the token
 * alone), and goes on only if both match the payload. Anything else — a
 * token it refuses, a person no longer in the home, a server it cannot
 * reach in time — is a refusal, before any session, model or memory is
 * touched (turn.ts).
 *
 * The token is sent in the Authorization header of that one request and
 * nowhere else; no error from it is logged.
 */

export interface VerifiedMember {
  readonly householdId: string;
  readonly memberId: string;
}

/** The token's member, or undefined when it is not one. Never throws on a refusal. */
export type VerifyMember = (token: string) => Promise<VerifiedMember | undefined>;

/** Long enough for a warm server; a cold one fails the turn, and the family app falls back. */
const VERIFY_TIMEOUT_MS = 5_000;

/** Asks GET /api/me on the same Wick server whose MCP endpoint is `mcpUrl`. */
export function verifyWithWick(mcpUrl: string, fetchImpl: typeof fetch = fetch): VerifyMember {
  const me = new URL('/api/me', mcpUrl);
  return async (token) => {
    try {
      const res = await fetchImpl(me, { headers: { authorization: `Bearer ${token}`, accept: 'application/json' }, signal: AbortSignal.timeout(VERIFY_TIMEOUT_MS) });
      if (res.status !== 200) return undefined;
      const body = (await res.json()) as { user?: { userId?: unknown }; household?: { householdId?: unknown } };
      const memberId = body.user?.userId;
      const householdId = body.household?.householdId;
      return typeof memberId === 'string' && memberId && typeof householdId === 'string' && householdId ? { householdId, memberId } : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * Bee proxy wire types.
 *
 * ⚠️ C — the proxy's endpoint list is ✅ V (docs.bee.computer), but exact
 * response field names are not published anywhere the build can cite, so
 * every shape below is a conservative subset: the fields Wick actually
 * reads, typed loosely (`Record<string, unknown>` passthrough for the rest)
 * so an extra or renamed field never throws before normalise.ts gets a
 * chance to run. Confirm against a real `bee proxy` response before the
 * demo and tighten here if it drifts.
 *
 * `BeeConversationRaw` exists only so callers can type the endpoint's
 * response shape; nothing in this package may pass its `utterances` field
 * to normalise.ts or any FactClass. INV-4 forbids it, and that discipline
 * belongs at the call site, not in a type. See normalise.ts's header.
 */

export interface BeeFactRaw {
  readonly id: string;
  /** Bee's own derived summary — not a verbatim quote. See normalise.ts. */
  readonly text: string;
  readonly confidence?: number;
  readonly tags?: readonly string[];
  readonly createdAt: string;
  readonly conversationId?: string;
}

export interface BeeTodoRaw {
  readonly id: string;
  readonly text: string;
  readonly completed?: boolean;
  readonly dueAt?: string;
  readonly createdAt: string;
  readonly conversationId?: string;
}

export interface BeeDailyRaw {
  readonly id: string;
  readonly date: string;
  readonly summary?: string;
  readonly factIds?: readonly string[];
}

export interface BeeConversationRaw {
  readonly id: string;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Never forward this. INV-4. */
  readonly utterances?: readonly { readonly text: string; readonly at: string }[];
}

export interface BeeMe {
  readonly id: string;
  readonly email?: string;
}

export interface BeeChangesResponse {
  readonly cursor: string;
  readonly changes: readonly { readonly entity: 'fact' | 'todo' | 'conversation' | 'daily'; readonly id: string }[];
}

export interface BeeSearchResult {
  readonly conversationId: string;
  readonly snippet: string;
  readonly score: number;
}

/** GET /v1/stream event payloads — see sse.ts. */
export type BeeStreamEvent =
  | { readonly type: 'fact'; readonly data: BeeFactRaw }
  | { readonly type: 'todo'; readonly data: BeeTodoRaw }
  | { readonly type: 'daily'; readonly data: BeeDailyRaw };

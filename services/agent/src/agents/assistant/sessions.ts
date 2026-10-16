/**
 * Where a member's conversation is kept between one question and the next.
 *
 * The agent lives for one invocation (turn.ts): it is built with the
 * member's token, answers, and is gone. What carries the conversation over
 * — what was asked, what the tools said, and a write paused for the
 * member's yes — is a Strands snapshot, saved by the SessionManager after
 * every invocation and restored when the next one starts.
 *
 * Durable storage is AgentCore Memory, through the session storage written
 * for Strands TypeScript as an open-source contribution
 * (`AgentCoreMemorySnapshotStorage`, vendored as
 * packages/strands-agentcore-session). This module does not import it: the
 * runtime's entrypoint hands its factory in (`sessionStorageFor`'s second
 * argument), so the agent is written, and tested, against Strands' own
 * `SnapshotStorage` interface and nothing else.
 *
 * Without it — no memory named, or no factory given — the conversation is
 * kept in this process. A runtime session is one member's (identity.ts), so
 * that is still one member's conversation, in their own microVM: it lasts
 * while the microVM is warm, and a cold start begins a new one.
 *
 * A snapshot carries no token: the token lives on the MCP client's headers
 * for one invocation and is never part of the agent's state (turn.ts).
 */
import { SNAPSHOT_SCHEMA_VERSION, type Snapshot, type SnapshotLocation, type SnapshotManifest, type SnapshotStorage } from '@strands-agents/sdk';

export type SessionStorage = { readonly snapshot: SnapshotStorage };

/** The vendored AgentCore Memory session storage, as the entrypoint builds it for one memory. */
export type AgentCoreSessionStorageFactory = (memoryId: string) => SessionStorage | SnapshotStorage;

const LATEST = 'latest';

const keyOf = (location: SnapshotLocation): string => `${location.sessionId}\u0000${location.scope}\u0000${location.scopeId}`;
/** Through JSON, as any real storage would: what is kept is a copy, and only what serialises. */
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

interface Kept {
  latest?: string;
  readonly history: Map<string, string>;
  manifest?: SnapshotManifest;
}

/** Strands' SnapshotStorage, in this process. */
export function inMemorySnapshotStorage(): SnapshotStorage {
  const kept = new Map<string, Kept>();
  const at = (location: SnapshotLocation): Kept => {
    const key = keyOf(location);
    let place = kept.get(key);
    if (!place) kept.set(key, (place = { history: new Map() }));
    return place;
  };

  return {
    async saveSnapshot({ location, snapshotId, isLatest, snapshot }) {
      const place = at(location);
      const json = JSON.stringify(snapshot);
      if (isLatest || snapshotId === LATEST) place.latest = json;
      else place.history.set(snapshotId, json);
    },
    async loadSnapshot({ location, snapshotId }) {
      const place = kept.get(keyOf(location));
      const json = snapshotId === undefined || snapshotId === LATEST ? place?.latest : place?.history.get(snapshotId);
      return json === undefined ? null : (JSON.parse(json) as Snapshot);
    },
    async listSnapshotIds({ location, limit, startAfter }) {
      const ids = [...(kept.get(keyOf(location))?.history.keys() ?? [])].sort();
      const after = startAfter === undefined ? ids : ids.filter((id) => id > startAfter);
      return limit === undefined ? after : after.slice(0, limit);
    },
    async deleteSession({ sessionId }) {
      for (const key of [...kept.keys()]) if (key.startsWith(`${sessionId}\u0000`)) kept.delete(key);
    },
    async loadManifest({ location }) {
      const manifest = kept.get(keyOf(location))?.manifest;
      return manifest ? copy(manifest) : { schemaVersion: SNAPSHOT_SCHEMA_VERSION, updatedAt: new Date().toISOString() };
    },
    async saveManifest({ location, manifest }) {
      at(location).manifest = copy(manifest);
    },
  };
}

/** One per process: every invocation in this microVM finds the conversation the last one left. */
const thisProcess: SessionStorage = { snapshot: inMemorySnapshotStorage() };

/**
 * The storage for this deployment: AgentCore Memory where AGENTCORE_MEMORY_ID
 * names one and the entrypoint gave the storage that writes to it, and this
 * process's own otherwise.
 */
export function sessionStorageFor(
  env: Readonly<Record<string, string | undefined>>,
  agentCore?: AgentCoreSessionStorageFactory,
): SessionStorage {
  const memoryId = env.AGENTCORE_MEMORY_ID;
  if (!memoryId || !agentCore) return thisProcess;
  const made = agentCore(memoryId);
  return 'snapshot' in made ? made : { snapshot: made };
}

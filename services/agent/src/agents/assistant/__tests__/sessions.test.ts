import { describe, expect, it } from 'vitest';
import type { Snapshot, SnapshotLocation, SnapshotStorage } from '@strands-agents/sdk';
import { inMemorySnapshotStorage, sessionStorageFor } from '../sessions.js';

const at = (sessionId: string, scopeId = 'wick-assistant'): SnapshotLocation => ({ sessionId, scope: 'agent', scopeId });
const snapshot = (said: string): Snapshot => ({
  scope: 'agent',
  schemaVersion: '1.0',
  createdAt: '2026-10-16T10:00:00.000Z',
  data: { messages: [{ role: 'user', content: [{ text: said }] }] },
  appData: {},
});

describe('inMemorySnapshotStorage — Strands’ SnapshotStorage, kept in this process', () => {
  it('gives back the latest snapshot of a session, and nothing for one never saved', async () => {
    const storage = inMemorySnapshotStorage();

    await storage.saveSnapshot({ location: at('s1'), snapshotId: 'latest', isLatest: true, snapshot: snapshot('first') });
    await storage.saveSnapshot({ location: at('s1'), snapshotId: 'latest', isLatest: true, snapshot: snapshot('second') });

    expect(await storage.loadSnapshot({ location: at('s1') })).toEqual(snapshot('second'));
    expect(await storage.loadSnapshot({ location: at('s2') })).toBeNull();
  });

  it('keeps what was saved as it was saved: a change to the agent afterwards changes nothing kept', async () => {
    const storage = inMemorySnapshotStorage();
    const saved = snapshot('first');

    await storage.saveSnapshot({ location: at('s1'), snapshotId: 'latest', isLatest: true, snapshot: saved });
    (saved.data.messages as { content: { text: string }[] }[])[0]!.content[0]!.text = 'changed';

    expect(await storage.loadSnapshot({ location: at('s1') })).toEqual(snapshot('first'));
  });

  it('keeps immutable snapshots by id, listed in order, a page at a time', async () => {
    const storage = inMemorySnapshotStorage();
    for (const id of ['0190-b', '0190-a', '0190-c']) {
      await storage.saveSnapshot({ location: at('s1'), snapshotId: id, isLatest: false, snapshot: snapshot(id) });
    }

    expect(await storage.listSnapshotIds({ location: at('s1') })).toEqual(['0190-a', '0190-b', '0190-c']);
    expect(await storage.listSnapshotIds({ location: at('s1'), limit: 1, startAfter: '0190-a' })).toEqual(['0190-b']);
    expect(await storage.loadSnapshot({ location: at('s1'), snapshotId: '0190-b' })).toEqual(snapshot('0190-b'));
    expect(await storage.loadSnapshot({ location: at('s1') })).toBeNull();
  });

  it('keeps each session and each scope apart', async () => {
    const storage = inMemorySnapshotStorage();

    await storage.saveSnapshot({ location: at('s1'), snapshotId: 'latest', isLatest: true, snapshot: snapshot('mine') });

    expect(await storage.loadSnapshot({ location: at('s2') })).toBeNull();
    expect(await storage.loadSnapshot({ location: at('s1', 'another-agent') })).toBeNull();
  });

  it('deletes a whole session', async () => {
    const storage = inMemorySnapshotStorage();
    await storage.saveSnapshot({ location: at('s1'), snapshotId: 'latest', isLatest: true, snapshot: snapshot('mine') });
    await storage.saveSnapshot({ location: at('s1'), snapshotId: '0190-a', isLatest: false, snapshot: snapshot('mine') });
    await storage.saveManifest({ location: at('s1'), manifest: { schemaVersion: '1.0', updatedAt: 'x' } });
    await storage.saveSnapshot({ location: at('s2'), snapshotId: 'latest', isLatest: true, snapshot: snapshot('theirs') });

    await storage.deleteSession({ sessionId: 's1' });

    expect(await storage.loadSnapshot({ location: at('s1') })).toBeNull();
    expect(await storage.listSnapshotIds({ location: at('s1') })).toEqual([]);
    expect((await storage.loadManifest({ location: at('s1') })).updatedAt).not.toBe('x');
    expect(await storage.loadSnapshot({ location: at('s2') })).toEqual(snapshot('theirs'));
  });

  it('has a manifest for every location, saved or not', async () => {
    const storage = inMemorySnapshotStorage();

    expect((await storage.loadManifest({ location: at('s1') })).schemaVersion).toBe('1.0');
    await storage.saveManifest({ location: at('s1'), manifest: { schemaVersion: '1.0', updatedAt: '2026-10-16' } });
    expect(await storage.loadManifest({ location: at('s1') })).toEqual({ schemaVersion: '1.0', updatedAt: '2026-10-16' });
  });
});

describe('sessionStorageFor — where a conversation is kept between questions', () => {
  const durable: SnapshotStorage = { ...inMemorySnapshotStorage() };

  it('is AgentCore Memory, through the session storage it is given, where the deployment names a memory', () => {
    const asked: string[] = [];
    const storage = sessionStorageFor({ AGENTCORE_MEMORY_ID: 'wick_assistant-abcdefghij' }, (memoryId) => {
      asked.push(memoryId);
      return { snapshot: durable };
    });

    expect(storage.snapshot).toBe(durable);
    expect(asked).toEqual(['wick_assistant-abcdefghij']);
  });

  it('takes a bare SnapshotStorage as readily as a SessionStorage', () => {
    expect(sessionStorageFor({ AGENTCORE_MEMORY_ID: 'm-abcdefghij' }, () => durable).snapshot).toBe(durable);
  });

  it('is this process’s own memory where there is no memory or no storage for it — warm, and lost with the microVM', () => {
    const a = sessionStorageFor({});
    const b = sessionStorageFor({ AGENTCORE_MEMORY_ID: 'm-abcdefghij' });

    expect(a.snapshot).toBe(b.snapshot);
    expect(a.snapshot).not.toBe(durable);
  });
});

import { describe, it, expect, vi } from 'vitest';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { localWorkdir, s3Publisher, spawnProcess, type S3Send } from '../io.js';

describe('localWorkdir', () => {
  it('creates a per-session directory, round-trips files, and removes it', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'wick-live-'));
    const wd = localWorkdir(root);

    const dir = await wd.create('s1');
    await wd.write(dir, 'in.sdp', 'v=0');
    expect(new TextDecoder().decode((await wd.read(dir, 'in.sdp'))!)).toBe('v=0');
    expect(await wd.read(dir, 'missing.ts')).toBeNull();

    await wd.remove(dir);
    expect(existsSync(dir)).toBe(false);
  });

  it('refuses a session id that would escape the root', async () => {
    const wd = localWorkdir(mkdtempSync(path.join(tmpdir(), 'wick-live-')));
    await expect(wd.create('../etc')).rejects.toThrow('bad_session_id');
  });
});

describe('spawnProcess', () => {
  it('resolves exited with the exit code', async () => {
    const p = spawnProcess(process.execPath, () => {})(['-e', 'process.exit(3)']);
    expect(await p.exited).toBe(3);
  });

  it('kill ends a running process', async () => {
    const p = spawnProcess(process.execPath, () => {})(['-e', 'setTimeout(() => {}, 60000)']);
    p.kill();
    expect(await p.exited).not.toBe(0);
  });

  it('kill escalates to SIGKILL when the process ignores SIGINT, so exited always settles', async () => {
    let ready!: () => void;
    const listening = new Promise<void>((r) => { ready = r; });
    const p = spawnProcess(process.execPath, (line) => { if (String(line.line).includes('ready')) ready(); }, { killGraceMs: 200 })([
      '-e', "process.on('SIGINT', () => {}); process.stderr.write('ready'); setTimeout(() => {}, 60000)",
    ]);
    await listening;
    p.kill();
    expect(await p.exited).not.toBe(0);
  }, 5_000);

  it('resolves exited (not throws) when the binary is missing', async () => {
    const p = spawnProcess('/nonexistent/ffmpeg', () => {})([]);
    expect(await p.exited).toBeNull();
  });
});

describe('s3Publisher', () => {
  it('puts with the content type and cache policy given', async () => {
    const send = vi.fn<S3Send>(async () => ({}));
    await s3Publisher(send, 'media').put('live/s1/live.m3u8', new Uint8Array([1]), 'application/vnd.apple.mpegurl', 'no-cache, no-store');
    expect(send.mock.calls[0]![0].input).toMatchObject({
      Bucket: 'media', Key: 'live/s1/live.m3u8', ContentType: 'application/vnd.apple.mpegurl', CacheControl: 'no-cache, no-store',
    });
  });

  it('removes everything under a live/ prefix, and refuses any other prefix', async () => {
    const send = vi.fn<S3Send>(async (cmd) =>
      'Prefix' in cmd.input ? { Contents: [{ Key: 'live/s1/a.ts' }, { Key: 'live/s1/live.m3u8' }] } : {});
    await s3Publisher(send, 'media').removePrefix('live/s1/');

    expect(send.mock.calls[1]![0].input).toEqual({
      Bucket: 'media',
      Delete: { Objects: [{ Key: 'live/s1/a.ts' }, { Key: 'live/s1/live.m3u8' }], Quiet: true },
    });
    await expect(s3Publisher(send, 'media').removePrefix('door/')).rejects.toThrow('not_a_live_prefix');
  });
});

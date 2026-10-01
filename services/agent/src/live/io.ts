/**
 * The bridge's real edges: a scratch directory, the ffmpeg process, and the
 * S3 prefix CloudFront serves. Kept apart from bridge.ts so the sequencing
 * there is tested without any of them.
 */
import { spawn } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { DeleteObjectsCommand, ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import type { BridgeDeps, FfmpegProcess } from './bridge.js';

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function localWorkdir(root: string): BridgeDeps['workdir'] {
  return {
    async create(sessionId) {
      if (!SAFE_ID.test(sessionId)) throw new Error('bad_session_id');
      const dir = path.join(root, sessionId);
      await mkdir(dir, { recursive: true });
      return dir;
    },
    write: (dir, name, text) => writeFile(path.join(dir, name), text, 'utf8'),
    async read(dir, name) {
      try {
        return new Uint8Array(await readFile(path.join(dir, name)));
      } catch {
        return null;
      }
    },
    remove: (dir) => rm(dir, { recursive: true, force: true }),
  };
}

export function spawnProcess(bin: string, log: BridgeDeps['log']): (args: string[]) => FfmpegProcess {
  return (args) => {
    const child = spawn(bin, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    // ffmpeg's warnings, trimmed: useful in CloudWatch, never media or tokens.
    child.stderr?.on('data', (chunk: Buffer) => log({ level: 'warn', msg: 'ffmpeg', line: chunk.toString('utf8').slice(0, 300) }));
    const exited = new Promise<number | null>((resolve) => {
      child.once('exit', (code) => resolve(code));
      child.once('error', () => resolve(null));
    });
    return { exited, kill: () => void child.kill('SIGINT') };
  };
}

export type S3Send = (command: { readonly input: object }) => Promise<{ Contents?: { Key?: string | undefined }[] | undefined }>;

export function s3Publisher(send: S3Send, bucket: string): BridgeDeps['publish'] {
  return {
    async put(key, body, contentType, cacheControl) {
      await send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: contentType, CacheControl: cacheControl }));
    },
    async removePrefix(prefix) {
      // Only ever a live session's own files — never the door imagery beside them.
      if (!/^live\/[A-Za-z0-9_-]+\/$/.test(prefix)) throw new Error('not_a_live_prefix');
      const listed = await send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix }));
      const keys = (listed.Contents ?? []).map((o) => o.Key).filter((k): k is string => Boolean(k));
      if (keys.length === 0) return;
      await send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
    },
  };
}

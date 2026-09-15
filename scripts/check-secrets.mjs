#!/usr/bin/env node
/**
 * Pre-commit gate: refuses to commit likely secrets.
 *
 * Three checks, in order:
 *   1. Staged file names against a blocklist (.env*, keys, certs) — independent
 *      of content, so it also catches files git would otherwise diff as binary.
 *   2. Staged additions containing this repo's own current .env values
 *      verbatim — catches copy-paste leaks of known credentials.
 *   3. Staged additions matching generic secret shapes (AWS key IDs, PEM
 *      private keys, JWTs) — catches secrets this repo doesn't already know
 *      about.
 *
 * False positive? `git commit --no-verify` bypasses this, as it does any git
 * hook.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';

// This file's own source mentions every pattern below by name; never scan it.
const SELF = 'scripts/check-secrets.mjs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8' });
}

function stagedFiles() {
  return git(['diff', '--cached', '--name-only', '--diff-filter=ACM'])
    .split('\n')
    .filter(Boolean);
}

const BLOCKED_FILENAME_PATTERNS = [
  /(^|\/)\.env(\..+)?$/i,
  /\.pem$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /(^|\/)id_rsa(\.pub)?$/i,
  /(^|\/)id_ed25519(\.pub)?$/i,
  /credentials\.json$/i,
];

function checkFilenames(files) {
  return files
    .filter((f) => f !== SELF && BLOCKED_FILENAME_PATTERNS.some((re) => re.test(f)))
    .map((f) => `staged file looks like a secret file: ${f}`);
}

/** Mirrors scripts/env.ts's parser; duplicated because this must run standalone. */
function parseEnvFile(text) {
  const out = {};
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    out[key] = line.slice(eq + 1).trim().replace(/^(['"])(.*)\1$/, '$2');
  }
  return out;
}

function knownSecretValues() {
  if (!existsSync('.env')) return [];
  const env = parseEnvFile(readFileSync('.env', 'utf8'));
  // Skip short values: they produce false positives and leak little on their own.
  return Object.entries(env)
    .filter(([, v]) => v && v.length >= 12)
    .map(([key, value]) => ({ key, value }));
}

const GENERIC_PATTERNS = [
  { name: 'AWS access key ID', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { name: 'PEM private key', re: /-----BEGIN[ A-Z]*PRIVATE KEY-----/ },
  { name: 'JWT', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
];

/** Map of staged file path -> array of newly added lines (content, not diff markup). */
function addedLinesByFile() {
  const diff = git(['diff', '--cached', '--unified=0', '--', '.']);
  const byFile = new Map();
  let current = null;
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++ ')) {
      const raw = line.slice(4);
      current = raw === '/dev/null' ? null : raw.replace(/^[ab]\//, '');
      if (current === SELF) current = null;
      continue;
    }
    if (line.startsWith('Binary files ')) {
      current = null;
      continue;
    }
    if (current && line.startsWith('+') && !line.startsWith('+++')) {
      if (!byFile.has(current)) byFile.set(current, []);
      byFile.get(current).push(line.slice(1));
    }
  }
  return byFile;
}

function checkContent(byFile, secrets) {
  const findings = [];
  for (const [file, lines] of byFile) {
    for (const line of lines) {
      for (const { key, value } of secrets) {
        if (line.includes(value)) {
          findings.push(`${file}: contains this repo's current ${key} value`);
        }
      }
      for (const { name, re } of GENERIC_PATTERNS) {
        if (re.test(line)) {
          findings.push(`${file}: looks like a ${name} — "${line.trim().slice(0, 60)}"`);
        }
      }
    }
  }
  return findings;
}

const files = stagedFiles();
if (files.length === 0) process.exit(0);

const findings = [
  ...checkFilenames(files),
  ...checkContent(addedLinesByFile(), knownSecretValues()),
];

if (findings.length > 0) {
  console.error('\n✖ pre-commit: possible secret exposure\n');
  for (const f of findings) console.error(`  - ${f}`);
  console.error('\nIf this is a false positive, `git commit --no-verify` bypasses this check.\n');
  process.exit(1);
}

import { describe, it, expect } from 'vitest';
import { parseEnvFile, resolveAws } from '../env.js';

describe('parseEnvFile', () => {
  it('reads the shape of a real .env, comments and blanks included', () => {
    const env = parseEnvFile(`
# Ring
CLIENT_ID_RING=abc123

AWS_ACCESS_KEY=AKIAEXAMPLE
RING_OAUTH_TOKEN="eyJ.header.sig"
`);
    expect(env.CLIENT_ID_RING).toBe('abc123');
    expect(env.AWS_ACCESS_KEY).toBe('AKIAEXAMPLE');
    expect(env.RING_OAUTH_TOKEN).toBe('eyJ.header.sig');
  });

  it('keeps = inside a value, which JWTs and base64 contain', () => {
    expect(parseEnvFile('T=abc==def').T).toBe('abc==def');
  });

  it('ignores lines that are not assignments', () => {
    const env = parseEnvFile('# just a comment\nnot a line\n=novalue\n9BAD=x\nOK=y');
    expect(Object.keys(env)).toEqual(['OK']);
  });
});

describe('resolveAws', () => {
  const KEYS = { AWS_ACCESS_KEY: 'AKIAEXAMPLE', AWS_SECRET_KEY: 'secret' };

  it('maps the names people actually write to the names the SDK reads', () => {
    // This is the whole bug: credentials present, under names nothing reads.
    const r = resolveAws(KEYS, {});
    expect(r.source).toBe('env-file-keys');
    expect(r.vars.AWS_ACCESS_KEY_ID).toBe('AKIAEXAMPLE');
    expect(r.vars.AWS_SECRET_ACCESS_KEY).toBe('secret');
  });

  it('accepts the canonical names too', () => {
    const r = resolveAws({ AWS_ACCESS_KEY_ID: 'A', AWS_SECRET_ACCESS_KEY: 'B' }, {});
    expect(r.source).toBe('env-file-keys');
    expect(r.vars.AWS_ACCESS_KEY_ID).toBe('A');
  });

  it('leaves the shell alone when it already has a profile', () => {
    const r = resolveAws(KEYS, { AWS_PROFILE: 'other' });
    expect(r.source).toBe('shell');
    expect(r.vars.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(r.detail).toContain('other');
  });

  it('leaves the shell alone when it already has an access key', () => {
    expect(resolveAws(KEYS, { AWS_ACCESS_KEY_ID: 'shell' }).source).toBe('shell');
  });

  it('falls back to a configured profile when .env has no keys', () => {
    const r = resolveAws({}, {}, ['wick', 'wick-dev']);
    expect(r.source).toBe('default-profile');
    expect(r.vars.AWS_PROFILE).toBe('wick-dev');
  });

  it('reports honestly when there is nothing to authenticate with', () => {
    const r = resolveAws({}, {}, []);
    expect(r.source).toBe('none');
    expect(r.vars.AWS_PROFILE).toBeUndefined();
  });

  it('always sets a region, because the SDK failure for a missing one is opaque', () => {
    expect(resolveAws({}, {}).vars.AWS_REGION).toBe('us-east-1');
    expect(resolveAws({}, { AWS_REGION: 'eu-west-1' }).vars.AWS_REGION).toBe('eu-west-1');
    expect(resolveAws({ AWS_REGION: 'eu-central-1' }, {}).vars.AWS_REGION).toBe('eu-central-1');
  });

  it('never carries a partial credential pair', () => {
    const r = resolveAws({ AWS_ACCESS_KEY: 'only-the-id' }, {}, ['wick-dev']);
    expect(r.source).not.toBe('env-file-keys');
    expect(r.vars.AWS_ACCESS_KEY_ID).toBeUndefined();
  });
});

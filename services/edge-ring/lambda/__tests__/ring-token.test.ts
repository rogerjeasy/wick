import { beforeEach, describe, expect, it, vi } from 'vitest';

/** Secrets Manager, in memory: which secrets exist, and every command sent. */
const vault = vi.hoisted(() => ({ secrets: new Map<string, string>(), sent: [] as { name: string; input: Record<string, unknown> }[] }));

vi.mock('@aws-sdk/client-secrets-manager', () => {
  const command = (name: string) =>
    class {
      readonly name = name;
      constructor(readonly input: Record<string, unknown>) {}
    };
  const notFound = () => Object.assign(new Error('not found'), { name: 'ResourceNotFoundException' });
  class SecretsManagerClient {
    async send(cmd: { name: string; input: { SecretId?: string; Name?: string; SecretString?: string } }) {
      vault.sent.push({ name: cmd.name, input: cmd.input });
      const id = cmd.input.SecretId ?? cmd.input.Name ?? '';
      if (cmd.name === 'Get') {
        if (!vault.secrets.has(id)) throw notFound();
        return { SecretString: vault.secrets.get(id) };
      }
      if (cmd.name === 'Put') {
        if (!vault.secrets.has(id)) throw notFound();
        vault.secrets.set(id, cmd.input.SecretString ?? '');
        return {};
      }
      if (cmd.name === 'Create') {
        vault.secrets.set(id, cmd.input.SecretString ?? '');
        return {};
      }
      if (!vault.secrets.delete(id)) throw notFound();
      return {};
    }
  }
  return {
    SecretsManagerClient,
    GetSecretValueCommand: command('Get'),
    PutSecretValueCommand: command('Put'),
    CreateSecretCommand: command('Create'),
    DeleteSecretCommand: command('Delete'),
  };
});

// @ts-expect-error — lambda sources are plain .mjs, deployed as-is.
const { deleteTokens, readTokens, writeTokens } = await import('../ring-token.mjs');

const SECRET = 'wick/ring/tokens/hh_a';
const created = () => vault.sent.filter((c) => c.name === 'Create').length;

beforeEach(() => {
  vault.secrets.clear();
  vault.sent.length = 0;
});

describe('writeTokens', () => {
  it('writes to the household\'s own secret', async () => {
    vault.secrets.set(SECRET, '{}');

    await writeTokens('hh_a', { access_token: 'a' });

    expect(JSON.parse(vault.secrets.get(SECRET)!)).toEqual({ access_token: 'a' });
    expect(created()).toBe(0);
  });

  it('never brings a secret into being for a refresh: a household that disconnected stays disconnected', async () => {
    // The organiser disconnected while a refresh was in flight. The refresh
    // comes back with fresh tokens and tries to store them.
    await expect(writeTokens('hh_a', { access_token: 'fresh', refresh_token: 'r' })).rejects.toThrow('not_linked');

    expect(vault.secrets.has(SECRET)).toBe(false);
    expect(created()).toBe(0);
  });

  it('creates the secret for a link, which is the only thing that may', async () => {
    await writeTokens('hh_a', { access_token: 'a' }, { create: true });

    expect(JSON.parse(vault.secrets.get(SECRET)!)).toEqual({ access_token: 'a' });
    expect(created()).toBe(1);
  });

  it('refuses a household id that could name another secret, before sending anything', async () => {
    await expect(writeTokens('../credentials', { access_token: 'a' }, { create: true })).rejects.toThrow('unsafe_household_id');
    expect(vault.sent).toEqual([]);
  });
});

describe('readTokens and deleteTokens', () => {
  it('reads nothing for a household that never linked', async () => {
    expect(await readTokens('hh_a')).toBeNull();
  });

  it('deletes at once, with no recovery window, and can be asked twice', async () => {
    vault.secrets.set(SECRET, '{"access_token":"a"}');

    await deleteTokens('hh_a');
    await deleteTokens('hh_a');

    expect(vault.secrets.has(SECRET)).toBe(false);
    expect(vault.sent.filter((c) => c.name === 'Delete')[0]?.input).toMatchObject({ SecretId: SECRET, ForceDeleteWithoutRecovery: true });
  });

  it('keeps one household\'s secret out of another\'s reach', async () => {
    vault.secrets.set(SECRET, '{"access_token":"a"}');

    expect(await readTokens('hh_b')).toBeNull();
    await deleteTokens('hh_b');
    expect(vault.secrets.has(SECRET)).toBe(true);
  });
});

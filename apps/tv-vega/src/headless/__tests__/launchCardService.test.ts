import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CARD_SERVICE_URI, launchCardService } from '../launchCardService.js';

const manifest = readFileSync(new URL('../../../manifest.toml', import.meta.url), 'utf8');

describe('launchCardService', () => {
  it("sends the launch to the service's own component URI", async () => {
    const openURL = vi.fn().mockResolvedValue(undefined);

    await launchCardService(openURL);

    expect(openURL).toHaveBeenCalledWith('pkg://com.wick.tv.card.service');
  });

  it('names a service component the manifest really declares', () => {
    const id = CARD_SERVICE_URI.replace('pkg://', '');

    expect(manifest).toMatch(new RegExp(`\\[\\[components\\.service\\]\\]\\s*\\nid\\s*=\\s*"${id.replace(/\./g, '\\.')}"`));
  });

  it('never throws when the platform refuses — Wick still works while it is on screen', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(launchCardService(() => Promise.reject(new Error('Missing privileges to send message')))).resolves.toBeUndefined();
  });
});

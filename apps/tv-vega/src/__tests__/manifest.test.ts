import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { MANIFEST_COMMAND_OPTIONS } from '../watch/mediaSession.js';

const manifest = readFileSync(new URL('../../manifest.toml', import.meta.url), 'utf8');

/** Every `[[wants.service]]` / `[[needs.service]]` id the package declares. */
function declaredServices(toml: string): string[] {
  return [...toml.matchAll(/\[\[(?:wants|needs)\.service\]\]\s*\nid\s*=\s*"([^"]+)"/g)].map((m) => m[1]!);
}

describe('manifest.toml — what the player needs to show a picture', () => {
  it('declares the media transform service: without it every H.264 decode fails, a black rectangle and MediaError 3', () => {
    // Seen on the VVD: "Unable connect to 'com.amazon.mediatransform.service'.
    // Missing the permissions needed to connect to the service." then
    // kepler_viddec_hw_h264 "Could not create Transform" for any stream.
    expect(declaredServices(manifest)).toContain('com.amazon.mediatransform.service');
  });

  it('keeps the rest of the w3cmedia playback chain', () => {
    expect(declaredServices(manifest)).toEqual(
      expect.arrayContaining(['com.amazon.media.server', 'com.amazon.mediabuffer.service', 'com.amazon.mediametrics.service', 'com.amazon.audio.stream']),
    );
  });
});

describe('manifest.toml — what the door needs to be announced outside Wick', () => {
  it('asks to post notifications: the toast is refused without it', () => {
    expect(manifest).toMatch(/\[\[wants\.privilege\]\]\s*\nid\s*=\s*"com\.amazon\.notification\.privilege\.post"/);
  });

  it("declares Wick a client of its own card service, the service the app starts", () => {
    expect(declaredServices(manifest)).toContain('com.wick.tv.card.service');
  });
});

describe('manifest.toml — the media session offers only what the film does', () => {
  const playback = manifest.match(/interface_name\s*=\s*"com\.amazon\.kepler\.media\.IMediaPlaybackServer"\s*\ncommand_options\s*=\s*\[([^\]]*)\]/);

  it('declares the playback server, with exactly the optional commands watch/mediaSession.ts obeys', () => {
    expect(playback).not.toBeNull();
    const options = [...playback![1]!.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(options).toEqual([...MANIFEST_COMMAND_OPTIONS]);
  });

  it('offers no Next or Previous: there is no playlist', () => {
    expect(playback![1]).not.toMatch(/Next|Previous/);
  });

  it('keeps the media category on the main component, which is what lets the platform send it commands', () => {
    expect(manifest).toMatch(/categories\s*=\s*\[[^\]]*"com\.amazon\.category\.kepler\.media"/);
  });
});

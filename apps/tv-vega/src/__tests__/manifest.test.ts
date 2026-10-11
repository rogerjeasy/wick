import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';

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

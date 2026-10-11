/**
 * The add-on package as it is checked in: addon-package/addon.json and the
 * files it points at. `alexa-ai deploy` would be the judge of these and Wick
 * cannot run it (FRICTION.md FL-001), so this is where a wrong field, a
 * placeholder or an icon of the wrong size is caught.
 */
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { checkManifest, manifestEndpoint, manifestImages, manifestLegalUrls } from '../addon/manifest-rules.js';
import { pngSize, sizeLabel } from '../addon/image-size.js';

const root = (path: string) => fileURLToPath(new URL(`../../${path}`, import.meta.url));
const manifest: unknown = JSON.parse(readFileSync(root('addon-package/addon.json'), 'utf8'));

/** GitHub Pages serves the repository's docs/ directory at this address. */
const PAGES = 'https://rogerjeasy.github.io/wick/';
const published = (uri: string) => root(`docs/${uri.slice(PAGES.length)}`);

describe('addon-package/addon.json', () => {
  it('holds everything the quickstart asks for, and no placeholder', () => {
    expect(checkManifest(manifest)).toEqual([]);
  });

  it('names the MCP server the stack deploys', () => {
    const variables = readFileSync(root('infra/variables.tf'), 'utf8');
    const issuer = /variable "mcp_issuer_url" \{[\s\S]*?default\s*=\s*"([^"]+)"/.exec(variables)?.[1];

    expect(issuer).toBeDefined();
    expect(manifestEndpoint(manifest)).toBe(`${issuer}/mcp`);
  });

  it('points every image at a file in docs/ that is the size it says', () => {
    const images = manifestImages(manifest);

    expect(images).toHaveLength(13);
    for (const image of images) {
      expect(image.uri.startsWith(PAGES), image.uri).toBe(true);
      const size = pngSize(new Uint8Array(readFileSync(published(image.uri))));
      expect(size && sizeLabel(size), image.uri).toBe(image.size);
    }
  });

  it('points both legal links at pages in docs/', () => {
    for (const page of manifestLegalUrls(manifest)) {
      expect(existsSync(published(page.uri)), page.uri).toBe(true);
    }
  });
});

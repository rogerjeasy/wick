/**
 * The family app's self-hosted libraries (scripts/family-vendor.mjs): the
 * typeface, Open Props, the Lucide icons and Motion. Never edited by hand,
 * published beside the page, and allowed by the policy without opening it
 * to another site.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { FONT_FAMILY, ICON_NAMES, VENDOR_DIR, vendorFiles } from '../../../scripts/family-vendor.mjs';

const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const tf = read('../../../infra/sim-alexa.tf');
const csp = read('../../../infra/csp/family-app.csp');
const html = read('../index.html');
const css = read('../styles.css');

describe('apps/sim-alexa/vendor', () => {
  it('is exactly what `npm run family:vendor` writes now, and nothing else', async () => {
    const files = await vendorFiles();
    expect(readdirSync(VENDOR_DIR).sort()).toEqual([...files.keys()].sort());
    for (const [name, content] of files) expect(readFileSync(path.join(VENDOR_DIR, name)).equals(content), name).toBe(true);
  }, 30_000);

  it('is published, every file with its own type', () => {
    for (const name of readdirSync(VENDOR_DIR)) expect(tf, name).toContain(`key           = "vendor/${name}"`);
    expect(tf).toContain('content_type  = "font/woff2"');
  });

  it('is loaded from the page’s own site, which the policy allows for fonts and nothing wider', () => {
    expect(csp).toMatch(/^font-src 'self';$/m);
    expect(html).toContain('<link rel="stylesheet" href="./vendor/fonts.css" />');
    expect(html).toContain('<link rel="stylesheet" href="./vendor/open-props.css" />');
    expect(css).toContain(`"${FONT_FAMILY}"`);
  });

  it('draws icons with createElementNS and never innerHTML, from Lucide’s own path data', async () => {
    const icons = (await vendorFiles()).get('icons.generated.js')!.toString('utf8');
    expect(icons).toContain('document.createElementNS(SVG,');
    expect(icons).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML/);
    for (const name of ICON_NAMES) expect(icons).toContain(`"${name}":[`);
  });

  it('bundles Motion as one module that imports nothing and exports animate and stagger', () => {
    const motion = readFileSync(path.join(VENDOR_DIR, 'motion.generated.js'), 'utf8');
    expect(motion).not.toMatch(/^import\s|\bimport\(/m);
    expect(motion).toMatch(/export\{[^}]*\bas animate\b[^}]*\}/);
    expect(motion).toMatch(/export\{[^}]*\bas stagger\b[^}]*\}/);
  });
});

/**
 * The family app runs under a Content-Security-Policy with no inline script
 * or style (infra/csp/family-app.csp, sent by CloudFront and by the local dev
 * server). These hold the page to it, and hold the deploy to publishing every
 * file the page and its manifest name.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
const html = read('../index.html');
const tf = read('../../../infra/sim-alexa.tf');
const csp = read('../../../infra/csp/family-app.csp');
const opsCsp = read('../../../infra/csp/ops-console.csp');

describe('the family app under its Content-Security-Policy', () => {
  it('has no inline script, style or handler for the policy to have to allow', () => {
    expect(html).not.toMatch(/<style/i);
    expect(html).not.toMatch(/\sstyle=/i);
    expect(html).not.toMatch(/\son[a-z]+=/i);
    for (const script of html.match(/<script[^>]*>/gi) ?? []) expect(script).toMatch(/\ssrc=/);
  });

  it('allows nothing unsafe, and no script but its own and the one hls.js file', () => {
    for (const policy of [csp, opsCsp]) {
      expect(policy).not.toMatch(/unsafe-/);
      expect(policy).toMatch(/^default-src 'none';/);
      expect(policy).toMatch(/frame-ancestors 'none'/);
      const scripts = /script-src ([^;]+);/.exec(policy)![1]!.trim().split(/\s+/);
      expect(scripts).toEqual(["'self'", 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.light.min.js']);
    }
  });

  it('loads hls.js from exactly the file the policy names, with Subresource Integrity', () => {
    for (const source of [read('../main.js'), read('../../ops-console/tv-core.js')]) {
      expect(source).toContain("const HLS_SRC = 'https://cdn.jsdelivr.net/npm/hls.js@1.5.17/dist/hls.light.min.js';");
      expect(source).toMatch(/script\.integrity = HLS_INTEGRITY/);
    }
  });

  it('is deployed with the policy and the security headers', () => {
    expect(tf).toMatch(/templatefile\("\$\{path\.module\}\/csp\/family-app\.csp"/);
    expect(tf).toMatch(/response_headers_policy_id = aws_cloudfront_response_headers_policy\.sim_alexa\.id/);
    expect(tf).toMatch(/microphone=\(self\)/);
    expect(tf).toMatch(/access_control_max_age_sec = 31536000/);
  });
});

describe('the family app as an app on a telephone', () => {
  const manifest = JSON.parse(read('../manifest.webmanifest')) as { icons: { src: string; purpose: string }[]; display: string; start_url: string };

  it('has a manifest an iPhone and an Android telephone can install it from', () => {
    expect(html).toContain('<link rel="manifest" href="./manifest.webmanifest" />');
    expect(html).toContain('<meta name="apple-mobile-web-app-capable" content="yes" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="./icons/apple-touch-icon.png" />');
    expect(manifest.display).toBe('standalone');
    expect(manifest.icons.map((i) => i.purpose).sort()).toEqual(['any', 'any', 'maskable']);
  });

  it('publishes every file the page and its manifest name, each with its own type', () => {
    const local = [...html.matchAll(/(?:href|src)="\.\/([^"]+)"/g)].map((m) => m[1]!);
    for (const file of local.filter((f) => !f.startsWith('icons/'))) expect(tf, file).toContain(`key           = "${file}"`);
    // The icons go up as one set, every PNG in the folder.
    expect(tf).toMatch(/fileset\("\$\{path\.module\}\/\.\.\/apps\/sim-alexa\/icons", "\*\.png"\)/);
    for (const icon of manifest.icons) readFileSync(new URL(`../${icon.src}`, import.meta.url));
    expect(tf).toContain('content_type  = "application/manifest+json; charset=utf-8"');
    expect(tf).toContain('content_type  = "text/css; charset=utf-8"');
  });
});

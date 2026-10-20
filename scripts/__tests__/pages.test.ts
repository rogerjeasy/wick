/**
 * The project page (docs/index.html) states numbers a judge reads first. It
 * once said "22 tools" and "Twelve features" long after both had grown. These
 * hold it to its sources, so it cannot go stale silently again:
 *
 *   - the MCP tools, counted from the code (every `registerTool(` in
 *     services/mcp-server/src/tools), and the README's count of them;
 *   - the features, as the README's table lists them, by number and by name.
 *
 * And every icon a page names is in the sprite `npm run pages:vendor` wrote.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../..', import.meta.url));
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

const TOOLS_DIR = 'services/mcp-server/src/tools';
const PAGES = ['docs/index.html', 'docs/link.html', 'docs/privacy.html', 'docs/terms.html', 'docs/404.html', 'docs/pair/index.html', 'docs/calm-points/index.html'];
const NUMBER_WORDS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty'];

const text = (html: string): string =>
  html
    .replace(/<[^>]+>/g, '')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

function toolsInCode(): number {
  return readdirSync(join(ROOT, TOOLS_DIR))
    .filter((f) => f.endsWith('.ts'))
    .reduce((sum, f) => sum + (read(join(TOOLS_DIR, f)).match(/registerTool\(/g) ?? []).length, 0);
}

/** The README's feature table: its heading's number word, and the bold name in each row. */
function readmeFeatures(): { word: string; names: string[] } {
  const readme = read('README.md');
  const heading = readme.match(/^### (\w+) features on top$/m);
  if (!heading) throw new Error('README has no "### … features on top" heading');
  const section = readme.slice(heading.index!).split(/\n## /)[0]!;
  const names = [...section.matchAll(/^\| \*\*([^*]+)\*\* \|/gm)].map((m) => m[1]!);
  return { word: heading[1]!.toLowerCase(), names };
}

describe('the project page agrees with the code and the README', () => {
  const page = read('docs/index.html');

  it('states the number of MCP tools the code registers, as the README does', () => {
    const tools = toolsInCode();
    expect(tools).toBeGreaterThan(0);
    expect(read('README.md')).toContain(`**${tools} MCP tools**`);
    expect(page).toContain(`<strong>${tools} MCP tools</strong>`);
    expect(page).toContain(`with ${tools} tools`);
    expect(page).toContain(`<dd>${tools}</dd>`);
    // No other count of tools anywhere on the page.
    for (const [, n] of text(page).matchAll(/(\d+) (?:MCP )?tools/g)) expect(Number(n)).toBe(tools);
  });

  it("states the README's number of features, and shows each one by name", () => {
    const { word, names } = readmeFeatures();
    expect(names.length).toBeGreaterThan(0);
    expect(word).toBe(NUMBER_WORDS[names.length]);
    const capitalised = word[0]!.toUpperCase() + word.slice(1);
    expect(page).toContain(`${capitalised} features on top`);

    const shown = [...page.matchAll(/<li class="feature"[^>]*><h3>([\s\S]*?)<\/h3>/g)].map((m) => text(m[1]!));
    expect(shown).toEqual(names);
  });
});

describe('the pages name only icons the sprite holds', () => {
  const sprite = read('docs/assets/vendor/icons.svg');
  const symbols = new Set([...sprite.matchAll(/<symbol id="([^"]+)"/g)].map((m) => m[1]));

  it.each([...PAGES, 'scripts/calm-points/page.ts'])('%s', (path) => {
    const named = [...read(path).matchAll(/icons\.svg#([a-z0-9-]+)/g)].map((m) => m[1]);
    for (const name of named) expect(symbols, `${path} names #${name}`).toContain(name);
  });
});

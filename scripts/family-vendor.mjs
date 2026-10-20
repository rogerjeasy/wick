/**
 * The family app's libraries, self-hosted (docs/design/DESIGN.md §3, §5, §8):
 *
 *   npm run family:vendor
 *
 * writes apps/sim-alexa/vendor/ from the root devDependencies:
 *
 * - the Atkinson Hyperlegible Next variable font (latin and latin-ext, upright)
 *   from @fontsource-variable/atkinson-hyperlegible-next, and fonts.css with
 *   its @font-face rules pointing at the copies beside it;
 * - open-props.css: Open Props' easing curves, shadows and size scale, as
 *   the package ships them;
 * - icons.generated.js: the Lucide icons the app uses (lucide-static), as
 *   path data, with one function that builds an icon with createElementNS —
 *   never innerHTML;
 * - motion.generated.js: Motion's `animate` (its Web Animations build,
 *   motion/mini) and `stagger`, bundled by esbuild into one ES module with
 *   no imports of its own.
 *
 * Nothing is fetched from anywhere when the page runs: the Content-Security-
 * Policy allows fonts, styles and scripts from the page's own site alone
 * (infra/csp/family-app.csp). Every file is committed and published as it is
 * (infra/sim-alexa.tf); apps/sim-alexa/__tests__/vendor.test.ts fails unless
 * running this again gives exactly the bytes checked in.
 *
 * Importing this file writes nothing; running it does.
 */
import { build } from 'esbuild';
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const MODULES = path.join(ROOT, 'node_modules');

export const VENDOR_DIR = path.join(ROOT, 'apps', 'sim-alexa', 'vendor');

/** The Lucide icons the family app draws, by Lucide's own names. One stroke weight, never an emoji (DESIGN.md §5). */
export const ICON_NAMES = [
  'arrow-up',
  'bell',
  'bell-ring',
  'calendar-check',
  'calendar-days',
  'check',
  'chevron-right',
  'circle',
  'circle-alert',
  'circle-check',
  'circle-dashed',
  'circle-question-mark',
  'clapperboard',
  'clock',
  'door-open',
  'ellipsis-vertical',
  'eye',
  'flame',
  'house',
  'image',
  'languages',
  'layout-grid',
  'link',
  'list',
  'list-checks',
  'lock',
  'log-out',
  'message-square',
  'message-square-reply',
  'mic',
  'phone',
  'send',
  'shield-check',
  'sparkles',
  'tv',
  'user',
  'users',
  'volume-2',
  'volume-x',
  'x',
];

const FONT_PACKAGE = '@fontsource-variable/atkinson-hyperlegible-next';
/** Upright only: the app sets nothing in italic. */
const FONT_FILES = ['atkinson-hyperlegible-next-latin-ext-wght-normal.woff2', 'atkinson-hyperlegible-next-latin-wght-normal.woff2'];
/** The name the app's styles ask for (styles.css --font). */
export const FONT_FAMILY = 'Atkinson Hyperlegible Next';
const OPEN_PROPS_FILES = ['easings.min.css', 'shadows.min.css', 'sizes.min.css'];

const read = (...parts) => readFileSync(path.join(MODULES, ...parts));
const versionOf = (name) => JSON.parse(read(name, 'package.json').toString('utf8')).version;

/** fonts.css: the package's own @font-face rules for the upright faces, pointing at the copies beside it. */
function fontsCss() {
  const source = read(FONT_PACKAGE, 'index.css').toString('utf8');
  const faces = source
    .split(/(?=\/\* atkinson)/)
    .filter((block) => FONT_FILES.some((file) => block.includes(file)))
    .map((block) => block.trim().replace(/url\(\.\/files\//g, 'url(./').replace(/font-family: '[^']+'/, `font-family: '${FONT_FAMILY}'`));
  return [
    `/* ${FONT_PACKAGE}@${versionOf(FONT_PACKAGE)} (SIL Open Font License 1.1), the Braille Institute's typeface for readers with low vision.\n   Written by scripts/family-vendor.mjs (npm run family:vendor); do not edit. */`,
    ...faces,
    '',
  ].join('\n\n');
}

/** open-props.css: the three files the app uses, as the package ships them. */
function openPropsCss() {
  return [
    `/* open-props@${versionOf('open-props')} (MIT): ${OPEN_PROPS_FILES.join(', ')}.`,
    '   Written by scripts/family-vendor.mjs (npm run family:vendor); do not edit. */',
    ...OPEN_PROPS_FILES.map((file) => read('open-props', file).toString('utf8').trim()),
    '',
  ].join('\n');
}

/** icons.generated.js: each icon's elements as data, and the function that draws one. */
function iconsJs() {
  const nodes = JSON.parse(read('lucide-static', 'icon-nodes.json').toString('utf8'));
  const missing = ICON_NAMES.filter((name) => !nodes[name]);
  if (missing.length) throw new Error(`lucide-static has no icon named ${missing.join(', ')}`);
  const data = Object.fromEntries(ICON_NAMES.map((name) => [name, nodes[name]]));
  return `/**
 * Lucide icons (lucide-static@${versionOf('lucide-static')}, ISC licence), as path data.
 * Written by scripts/family-vendor.mjs (npm run family:vendor); do not edit.
 *
 * An icon is built with createElementNS, never parsed from markup, and always stands
 * beside a word or carries an accessible label (docs/design/DESIGN.md §5).
 */
const SVG = 'http://www.w3.org/2000/svg';

/** @type {Record<string, [string, Record<string, string>][]>} */
export const ICONS = ${JSON.stringify(data)};

export const ICON_NAMES = Object.keys(ICONS);

/**
 * One icon, drawn in the colour of the words around it.
 *
 * @param {string} name  one of ICON_NAMES
 * @param {{ label?: string, className?: string }} [options]  a label makes it an image with that name; without one it is hidden from a screen reader
 * @returns {SVGSVGElement}
 */
export function icon(name, options = {}) {
  const parts = ICONS[name];
  if (!parts) throw new Error(\`No icon named \${name}\`);
  const svg = document.createElementNS(SVG, 'svg');
  const attributes = {
    class: ['icon', \`icon-\${name}\`, options.className].filter(Boolean).join(' '),
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': '2',
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    focusable: 'false',
  };
  for (const [key, value] of Object.entries(attributes)) svg.setAttribute(key, value);
  if (options.label) {
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', options.label);
  } else {
    svg.setAttribute('aria-hidden', 'true');
  }
  for (const [tag, attrs] of parts) {
    const part = document.createElementNS(SVG, tag);
    for (const [key, value] of Object.entries(attrs)) part.setAttribute(key, value);
    svg.appendChild(part);
  }
  return svg;
}
`;
}

/** motion.generated.js: Motion's animate and stagger, one ES module with nothing to import. */
async function motionJs() {
  const result = await build({
    // Motion's mini animate runs on the browser's own Web Animations API: a tenth of the size of the full one.
    stdin: { contents: "export { animate } from 'motion/mini';\nexport { stagger } from 'motion';", resolveDir: ROOT, loader: 'js' },
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2020',
    minify: true,
    legalComments: 'none',
    write: false,
    logLevel: 'silent',
  });
  const code = result.outputFiles[0].text;
  return `/* motion@${versionOf('motion')} (MIT, Motion B.V.): animate (motion/mini) and stagger. Written by scripts/family-vendor.mjs (npm run family:vendor); do not edit. */\n${code}`;
}

/**
 * Every file the script writes, by its name in apps/sim-alexa/vendor/.
 *
 * @returns {Promise<Map<string, Buffer>>}
 */
export async function vendorFiles() {
  const files = new Map();
  for (const file of FONT_FILES) files.set(file, read(FONT_PACKAGE, 'files', file));
  files.set('fonts.css', Buffer.from(fontsCss()));
  files.set('open-props.css', Buffer.from(openPropsCss()));
  files.set('icons.generated.js', Buffer.from(iconsJs()));
  files.set('motion.generated.js', Buffer.from(await motionJs()));
  return files;
}

async function main() {
  const files = await vendorFiles();
  mkdirSync(VENDOR_DIR, { recursive: true });
  // Nothing left over from an earlier run: the folder is exactly what is written.
  for (const name of readdirSync(VENDOR_DIR)) if (!files.has(name)) rmSync(path.join(VENDOR_DIR, name));
  for (const [name, content] of files) writeFileSync(path.join(VENDOR_DIR, name), content);
  console.log(`Wrote ${files.size} files to ${path.relative(ROOT, VENDOR_DIR)}/`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) await main();

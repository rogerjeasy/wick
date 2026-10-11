/**
 * What the Fire OS app swaps when it loads the Vega app's source
 * (apps/tv-vega/src). This is the whole of the difference between the two
 * at the level of modules, and metro.config.js applies exactly this table.
 *
 * - MODULES: a package name the shared source imports, and the file that
 *   answers to it here.
 * - FILES: a shared source file, and the file loaded in its place.
 * - Any other `@amazon-devices/*` name resolves to UNAVAILABLE.
 *
 * src/__tests__/parity.test.ts holds every entry to exporting what the
 * shared source imports from the thing it stands in for.
 */
const path = require('node:path');

const projectRoot = __dirname;
const repoRoot = path.resolve(projectRoot, '../..');
const vegaApp = path.join(repoRoot, 'apps/tv-vega');
const here = (file) => path.join(projectRoot, file);

module.exports = {
  projectRoot,
  repoRoot,
  vegaApp,
  MODULES: {
    '@amazon-devices/react-native-kepler': here('src/adapters/kepler.ts'),
    '@amazon-devices/react-native-w3cmedia': here('src/adapters/w3cmedia.tsx'),
    '@amazon-devices/kepler-file-system': here('src/adapters/fileSystem.ts'),
    '@wick/contracts': path.join(repoRoot, 'packages/contracts/src/index.ts'),
    '@wick/vega-calm-ui': path.join(repoRoot, 'packages/vega-calm-ui/src/index.ts'),
  },
  FILES: {
    [path.join(vegaApp, 'src/headless/launchCardService.ts')]: here('src/overrides/launchCardService.ts'),
  },
  UNAVAILABLE: here('src/adapters/unavailable.ts'),
};

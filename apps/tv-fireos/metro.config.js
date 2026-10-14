const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');
const { projectRoot, repoRoot, vegaApp, MODULES, FILES, UNAVAILABLE } = require('./adapters.config');

/**
 * The Fire OS app has no screens of its own. It bundles the Vega app's
 * source (apps/tv-vega/src) and swaps what adapters.config.js lists: four
 * Amazon packages for adapters, and one file for an override.
 *
 * Three things make that work:
 *
 * 1. The swap table itself, applied below.
 * 2. Every package the shared source imports — react, react-native, mqtt —
 *    is resolved as if the import were written in this app, so it comes
 *    from this app's node_modules. Left to itself the bundler would walk up
 *    from apps/tv-vega/src and find the Vega app's own React Native, which
 *    is a different one, and a second copy of React.
 * 3. The shared source spells relative imports with a `.js` extension (the
 *    TypeScript NodeNext convention). The bundler treats a written
 *    extension as final, so it is taken off and the usual .ts/.tsx search
 *    runs. Only for our own source: a package's `./x.js` means that file.
 *
 * @type {import('metro-config').MetroConfig}
 */
const inside = (dir, file) => file === dir || file.startsWith(dir + path.sep);
const anchor = path.join(projectRoot, 'index.js');

const config = {
  watchFolders: [vegaApp, path.join(repoRoot, 'packages')],
  resolver: {
    // The Vega app's own installs and builds are not this app's business.
    blockList: [
      new RegExp(`${vegaApp}/(node_modules|build|buildinfo\\.json)(/.*)?$`),
      new RegExp(`${repoRoot}/packages/[^/]+/(node_modules|dist)/.*`),
    ],
    resolveRequest: (context, moduleName, platform) => {
      if (MODULES[moduleName]) return { type: 'sourceFile', filePath: MODULES[moduleName] };
      if (moduleName.startsWith('@amazon-devices/')) return { type: 'sourceFile', filePath: UNAVAILABLE };

      const relative = moduleName.startsWith('.');
      const ours = !context.originModulePath.includes(`${path.sep}node_modules${path.sep}`);
      const shared = !inside(projectRoot, context.originModulePath);

      let resolution;
      if (!relative && shared) {
        resolution = context.resolveRequest({ ...context, originModulePath: anchor }, moduleName, platform);
      } else if (relative && ours && moduleName.endsWith('.js')) {
        try {
          resolution = context.resolveRequest(context, moduleName.slice(0, -3), platform);
        } catch {
          resolution = context.resolveRequest(context, moduleName, platform);
        }
      } else {
        resolution = context.resolveRequest(context, moduleName, platform);
      }

      const override = resolution.type === 'sourceFile' ? FILES[resolution.filePath] : undefined;
      return override ? { ...resolution, filePath: override } : resolution;
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);

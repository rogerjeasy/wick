const path = require('node:path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

/**
 * Metro configuration
 * https://facebook.github.io/metro/docs/configuration
 *
 * Wick is an npm workspaces monorepo (root package.json's "workspaces"), so
 * most dependencies — including @babel/runtime, which every RN bundle needs
 * — are hoisted to the repo root's node_modules, not
 * apps/tv-vega/node_modules. Metro's default config only looks in this
 * project's own node_modules, so without watchFolders + nodeModulesPaths
 * every hoisted package fails to resolve at bundle time even though `npm
 * ls` shows it installed correctly.
 *
 * @type {import('metro-config').MetroConfig}
 */
const projectRoot = __dirname;
const monorepoRoot = path.resolve(projectRoot, '../..');

const defaultConfig = getDefaultConfig(projectRoot);

/**
 * getDefaultConfig() already installs its own resolver.resolveRequest —
 * confirmed by inspecting the returned config directly (it's a function,
 * not undefined). That's the Vega SDK's own package-redirection logic:
 * without it, real react-native's own internal files (e.g.
 * Libraries/ReactNative/BridgelessUIManager.js, imported unconditionally by
 * every app via AppContainer/renderApplication, nothing to do with this
 * app's own code) resolve their own platform-specific requires (e.g.
 * `import Platform from '../Utilities/Platform'`) against plain
 * react-native's own Libraries tree, which only ships .ios.js/.android.js —
 * never against @amazon-devices/react-native-kepler's Libraries tree, which
 * is where the real Platform.kepler.js implementation actually lives, in a
 * completely different node_modules subtree. Falling through to plain
 * react-native's Platform.js (a self-referencing back-compat stub, never
 * meant to be the real resolution) crashes at runtime with "Cannot read
 * property 'select' of undefined" — every single launch, unconditionally,
 * before this app's own code ever runs. Overwriting resolveRequest instead
 * of chaining through the original is exactly what caused that: it silently
 * discards this redirection. Capture it here and delegate to it explicitly.
 */
const defaultResolveRequest = defaultConfig.resolver.resolveRequest;

const config = {
  watchFolders: [monorepoRoot],
  resolver: {
    nodeModulesPaths: [path.resolve(projectRoot, 'node_modules'), path.resolve(monorepoRoot, 'node_modules')],
    // Every relative import in this app spells a literal .js extension
    // (TypeScript NodeNext/ESM convention — tsconfig maps it to the actual
    // .ts/.tsx source, matching how tsc and Node's own ESM resolver both
    // work). Metro's resolver, unlike those, treats an explicit extension as
    // final and never retries sourceExts — so without this override, every
    // relative import in the codebase fails to bundle.
    resolveRequest: (context, moduleName, platform) => {
      const resolve = defaultResolveRequest ?? context.resolveRequest;
      if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
        const withoutExt = moduleName.slice(0, -3);
        for (const ext of ['.ts', '.tsx', '.js']) {
          try {
            return resolve(context, withoutExt + ext, platform);
          } catch {
            // try the next extension
          }
        }
      }
      return resolve(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(defaultConfig, config);

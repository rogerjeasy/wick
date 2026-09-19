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
      if (moduleName.startsWith('.') && moduleName.endsWith('.js')) {
        const withoutExt = moduleName.slice(0, -3);
        for (const ext of ['.ts', '.tsx', '.js']) {
          try {
            return context.resolveRequest(context, withoutExt + ext, platform);
          } catch {
            // try the next extension
          }
        }
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(projectRoot), config);

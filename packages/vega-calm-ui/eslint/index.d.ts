import type { ESLint, Linter } from 'eslint';

declare const plugin: ESLint.Plugin & {
  configs: { recommended: Linter.Config } & Record<string, Linter.Config>;
};
export default plugin;

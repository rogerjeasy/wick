// @ts-check
/**
 * ESLint rules for calm 10-foot UI. They catch at lint time what the
 * components refuse at render time (src/constraints.ts), and what a runtime
 * check cannot see at all — a timer that would dismiss a card.
 *
 *   min-font-size     a literal fontSize below 32 (configurable)
 *   no-alarm-colour   a saturated red colour literal, by hue
 *   max-actions       more than three actions written on a CalmCard / TwoPhaseCard
 *   no-auto-dismiss   setTimeout / setInterval in a component that renders one
 *
 * Usage (flat config):
 *
 *   import calm from 'vega-calm-ui/eslint';
 *   export default [calm.configs.recommended];
 */
import maxActions from './rules/max-actions.js';
import minFontSize from './rules/min-font-size.js';
import noAlarmColour from './rules/no-alarm-colour.js';
import noAutoDismiss from './rules/no-auto-dismiss.js';

/** @type {import('eslint').ESLint.Plugin & { configs: Record<string, import('eslint').Linter.Config> }} */
const plugin = {
  meta: { name: 'vega-calm-ui' },
  rules: {
    'max-actions': maxActions,
    'min-font-size': minFontSize,
    'no-alarm-colour': noAlarmColour,
    'no-auto-dismiss': noAutoDismiss,
  },
  configs: {},
};

const ERROR = /** @type {const} */ ('error');

plugin.configs.recommended = {
  name: 'vega-calm-ui/recommended',
  plugins: { 'vega-calm-ui': plugin },
  rules: {
    'vega-calm-ui/max-actions': ERROR,
    'vega-calm-ui/min-font-size': ERROR,
    'vega-calm-ui/no-alarm-colour': ERROR,
    'vega-calm-ui/no-auto-dismiss': ERROR,
  },
};

export default plugin;

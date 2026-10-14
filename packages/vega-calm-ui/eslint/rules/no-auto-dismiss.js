// @ts-check
import { jsxName, outermostComponent } from '../ast.js';

const DEFAULT_COMPONENTS = ['CalmCard', 'TwoPhaseCard'];
const TIMERS = new Set(['setTimeout', 'setInterval']);
const GLOBALS = new Set(['window', 'global', 'globalThis', 'self']);

/**
 * The timer a call starts, if it is `setTimeout(…)` / `setInterval(…)`,
 * bare or on a global object.
 * @param {any} callee
 * @returns {string | null}
 */
function timerName(callee) {
  if (callee.type === 'Identifier' && TIMERS.has(callee.name)) return callee.name;
  if (
    callee.type === 'MemberExpression' &&
    !callee.computed &&
    callee.object.type === 'Identifier' &&
    GLOBALS.has(callee.object.name) &&
    callee.property.type === 'Identifier' &&
    TIMERS.has(callee.property.name)
  ) {
    return callee.property.name;
  }
  return null;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow setTimeout / setInterval in a component that renders a calm card: nothing on it disappears or changes on a countdown.',
      url: 'https://github.com/rogerjeasy/vega-calm-ui#no-auto-dismiss',
    },
    schema: [
      {
        type: 'object',
        properties: {
          components: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      timer:
        '{{timer}} in a component that renders <{{component}}>. A calm card stays until the viewer ' +
        'answers it; nothing on it may dismiss itself or change on a timer.',
    },
  },
  create(context) {
    const options = /** @type {{ components?: string[] } | undefined} */ (context.options[0]);
    const components = new Set(options?.components ?? DEFAULT_COMPONENTS);

    /** @type {Map<any, string>} component scope -> the calm card it renders */
    const rendering = new Map();
    /** @type {{ node: any, timer: string, scope: any }[]} */
    const timers = [];

    return {
      /** @param {any} node a JSXOpeningElement */
      JSXOpeningElement(node) {
        const name = jsxName(node.name);
        if (!name || !components.has(name)) return;
        const scope = outermostComponent(node);
        if (scope && !rendering.has(scope)) rendering.set(scope, name);
      },
      CallExpression(node) {
        const timer = timerName(node.callee);
        if (timer) timers.push({ node, timer, scope: outermostComponent(node) });
      },
      'Program:exit'() {
        for (const { node, timer, scope } of timers) {
          const component = scope ? rendering.get(scope) : undefined;
          if (component) context.report({ node, messageId: 'timer', data: { timer, component } });
        }
      },
    };
  },
};

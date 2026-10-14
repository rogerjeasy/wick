// @ts-check
import { jsxName, unwrap } from '../ast.js';

const DEFAULT_COMPONENTS = ['CalmCard', 'TwoPhaseCard'];

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow more than three actions on a calm card (caught at lint time rather than at render).',
      url: 'https://github.com/rogerjeasy/vega-calm-ui#max-actions',
    },
    schema: [
      {
        type: 'object',
        properties: {
          max: { type: 'integer', minimum: 1 },
          components: { type: 'array', items: { type: 'string' }, uniqueItems: true },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      tooMany:
        '<{{component}}> is given {{count}} actions; a calm card has at most {{max}}. ' +
        'Every extra button is another decision for someone reading slowly with a remote.',
    },
  },
  create(context) {
    const options = /** @type {{ max?: number, components?: string[] } | undefined} */ (context.options[0]);
    const max = options?.max ?? 3;
    const components = new Set(options?.components ?? DEFAULT_COMPONENTS);

    return {
      /** @param {any} node a JSXOpeningElement */
      JSXOpeningElement(node) {
        const component = jsxName(node.name);
        if (!component || !components.has(component)) return;

        for (const attribute of node.attributes) {
          if (attribute.type !== 'JSXAttribute' || attribute.name.name !== 'actions') continue;
          if (attribute.value?.type !== 'JSXExpressionContainer') continue;
          const list = unwrap(/** @type {any} */ (attribute.value.expression));
          if (list?.type !== 'ArrayExpression') continue;
          // A spread could add any number; only what is written out is counted.
          const count = list.elements.filter((/** @type {any} */ e) => e && e.type !== 'SpreadElement').length;
          if (count > max) {
            context.report({
              node: attribute,
              messageId: 'tooMany',
              data: { component, count: String(count), max: String(max) },
            });
          }
        }
      },
    };
  },
};

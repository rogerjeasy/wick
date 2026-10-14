// @ts-check
import { propertyName, numericValue } from '../ast.js';

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow a literal fontSize below the 10-foot floor (32 by default).',
      url: 'https://github.com/rogerjeasy/vega-calm-ui#min-font-size',
    },
    schema: [
      {
        type: 'object',
        properties: { min: { type: 'number', minimum: 1 } },
        additionalProperties: false,
      },
    ],
    messages: {
      tooSmall:
        'fontSize {{value}} is below the {{min}}pt floor for text read from across a room. ' +
        "Use fontSize('body') (32) or larger.",
    },
  },
  create(context) {
    const min = /** @type {{ min?: number } | undefined} */ (context.options[0])?.min ?? 32;

    return {
      Property(node) {
        if (propertyName(node) !== 'fontSize') return;
        const value = numericValue(node.value);
        if (value !== null && value < min) {
          context.report({ node: node.value, messageId: 'tooSmall', data: { value: String(value), min: String(min) } });
        }
      },
    };
  },
};

// @ts-check
import { alarmHueOfRgb, parseColour, parseNamedColour } from '../colour.js';
import { propertyName, stringValue } from '../ast.js';

/** A style key or prop that holds a colour: `color`, `backgroundColor`, `tintColor`, … */
const COLOUR_KEY = /colou?r$/i;

/**
 * @param {any} node a Literal or TemplateLiteral
 * @returns {boolean} whether the string sits where a colour keyword would be a colour
 */
function inColourPosition(node) {
  const parent = node.parent;
  if (!parent) return false;
  if (parent.type === 'Property' && parent.value === node) return COLOUR_KEY.test(propertyName(parent) ?? '');
  if (parent.type === 'JSXAttribute') return COLOUR_KEY.test(parent.name?.name ?? '');
  if (parent.type === 'JSXExpressionContainer' && parent.parent?.type === 'JSXAttribute') {
    return COLOUR_KEY.test(parent.parent.name?.name ?? '');
  }
  return false;
}

/** @type {import('eslint').Rule.RuleModule} */
export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow saturated red colour literals: on a television, red reads as an alarm.',
      url: 'https://github.com/rogerjeasy/vega-calm-ui#no-alarm-colour',
    },
    schema: [],
    messages: {
      alarm:
        '"{{text}}" is a saturated red (hue {{hue}}deg). On a television red reads as an alarm; ' +
        'use an amber or a neutral instead.',
    },
  },
  create(context) {
    /** @param {any} node */
    function check(node) {
      const text = stringValue(node);
      if (text === null) return;
      // A colour written as #hex or rgb() is a colour wherever it appears;
      // a word like "red" is only a colour where a colour is expected.
      const channels = parseColour(text) ?? (inColourPosition(node) ? parseNamedColour(text) : null);
      if (!channels) return;
      const hue = alarmHueOfRgb(...channels);
      if (hue !== null) {
        context.report({ node, messageId: 'alarm', data: { text: text.trim(), hue: hue.toFixed(0) } });
      }
    }

    return {
      Literal: check,
      TemplateLiteral: check,
    };
  },
};

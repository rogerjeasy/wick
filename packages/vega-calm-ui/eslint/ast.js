// @ts-check
/**
 * Small AST helpers shared by the rules. Written against ESTree, with the
 * TypeScript wrapper nodes (`x as const`, `x satisfies T`, `x!`) looked
 * through, so the rules work with espree and with typescript-eslint's parser.
 */

/**
 * @typedef {{ type: string, [key: string]: any }} AnyNode
 */

/**
 * An expression with TypeScript-only wrappers removed.
 * @param {AnyNode} node
 * @returns {AnyNode}
 */
export function unwrap(node) {
  let current = node;
  while (
    current &&
    (current.type === 'TSAsExpression' ||
      current.type === 'TSSatisfiesExpression' ||
      current.type === 'TSNonNullExpression' ||
      current.type === 'TSTypeAssertion')
  ) {
    current = current.expression;
  }
  return current;
}

/**
 * The name of an object property's key, when it is written plainly
 * (`fontSize: …` or `'fontSize': …`). Null for computed keys.
 * @param {AnyNode} property
 * @returns {string | null}
 */
export function propertyName(property) {
  if (property.computed) return null;
  const key = property.key;
  if (key.type === 'Identifier') return key.name;
  if (key.type === 'Literal' && typeof key.value === 'string') return key.value;
  return null;
}

/**
 * The value of a numeric literal, including a signed one. Null for anything
 * that is not a number written in the source.
 * @param {AnyNode} expression
 * @returns {number | null}
 */
export function numericValue(expression) {
  const node = unwrap(expression);
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'number') return node.value;
  if (node.type === 'UnaryExpression' && (node.operator === '-' || node.operator === '+')) {
    const inner = numericValue(node.argument);
    return inner === null ? null : node.operator === '-' ? -inner : inner;
  }
  return null;
}

/**
 * The text of a string written in the source: a string literal, or a
 * template literal with no substitutions. Null otherwise.
 * @param {AnyNode} expression
 * @returns {string | null}
 */
export function stringValue(expression) {
  const node = unwrap(expression);
  if (!node) return null;
  if (node.type === 'Literal' && typeof node.value === 'string') return node.value;
  if (node.type === 'TemplateLiteral' && node.expressions.length === 0) return node.quasis[0].value.cooked ?? null;
  return null;
}

/**
 * The last segment of a JSX element's name: `CalmCard` for `<CalmCard>` and
 * for `<ui.CalmCard>`.
 * @param {AnyNode} name
 * @returns {string | null}
 */
export function jsxName(name) {
  if (name.type === 'JSXIdentifier') return name.name;
  if (name.type === 'JSXMemberExpression') return jsxName(name.property);
  return null;
}

/**
 * Whether a node is a function of any kind.
 * @param {AnyNode} node
 */
export function isFunction(node) {
  return (
    node.type === 'FunctionDeclaration' || node.type === 'FunctionExpression' || node.type === 'ArrowFunctionExpression'
  );
}

/**
 * The outermost function or class that contains a node — for a component,
 * the component itself, however deeply the node sits in callbacks, effects
 * or methods within it. Null at module level.
 * @param {AnyNode} node
 * @returns {AnyNode | null}
 */
export function outermostComponent(node) {
  let found = null;
  for (let current = node.parent; current; current = current.parent) {
    if (isFunction(current) || current.type === 'ClassDeclaration' || current.type === 'ClassExpression') {
      found = current;
    }
  }
  return found;
}

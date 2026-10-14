/**
 * Stops raw infrastructure errors from reaching the family/Alexa+ surface.
 *
 * The MCP SDK converts any error thrown inside a tool handler into
 * `{content: [{type: 'text', text: error.message}], isError: true}` verbatim
 * (node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js) — no
 * filtering. A DynamoDB `AccessDeniedException` (or any other AWS SDK error)
 * can carry an account ID or ARN, and this product's own refusal voice
 * (§6.4: warm and specific, never a raw error) is violated the moment that
 * text reaches a family member or Alexa+.
 *
 * `withFriendlyErrors` wraps a tool's callback, logs the real error
 * server-side, and returns a calm, generic response instead. Deliberately
 * minimal — no error taxonomy, just stop the leak.
 */
export const SOMETHING_WENT_WRONG_TEXT = 'Something went wrong on my end — try again in a moment.';

export function withFriendlyErrors<Args extends unknown[], R>(
  handler: (...args: Args) => Promise<R>,
): (...args: Args) => Promise<R | { content: [{ type: 'text'; text: string }]; isError: true }> {
  return async (...args: Args) => {
    try {
      return await handler(...args);
    } catch (err) {
      console.error('[wick/mcp-server] tool handler failed:', err);
      return {
        content: [{ type: 'text' as const, text: SOMETHING_WENT_WRONG_TEXT }],
        isError: true as const,
      };
    }
  };
}

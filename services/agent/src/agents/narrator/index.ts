/**
 * Narrator — the weekly narrative. PRECOMPUTED, never generated in-request.
 *
 * Alexa+ requires MCP round trips under 500ms, so generating a week's prose
 * inside a tool call is not an option. A weekly schedule writes it; the MCP tool
 * does a single GetItem.
 *
 * THE MODEL NEVER COUNTS. Retrieve the timeline and the rhythm baseline, compute
 * every delta deterministically, then hand numbers and facts to the model for
 * prose. Anything it could get arithmetically wrong is computed before it sees it.
 *
 * INV-7: written to the resident's television first. residentSeenAt gates family
 * readability. Nothing is said about the resident behind their back.
 *
 * Model: Claude — runs weekly, offline, and prose quality IS the product here.
 * See docs/WICK-TECHNICAL.md §5.4.
 */
export {};

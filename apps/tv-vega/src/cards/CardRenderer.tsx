/**
 * The single renderer for all three card types.
 *
 * Non-negotiable, from docs/WICK.md Part 5 — enforced by @wick/vega-calm-ui:
 *   - minimum 32pt type, contrast >= 7:1
 *   - at most 3 actions, reachable with D-pad + OK only, no text entry
 *   - never auto-dismiss, never a timer (Principle 9)
 *   - no red, no badges, no beeps
 *   - animation <= 200ms ease-out, nothing that startles
 *   - DOOR renders in the lower third and never pauses, covers or silences
 */
// TODO(S1): DOOR lower-third presentation + two-phase patch handling.
// TODO(S3): DAY full-screen presentation, at most 3 items.
export {};

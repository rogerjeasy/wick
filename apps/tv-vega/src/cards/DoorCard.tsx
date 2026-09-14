/**
 * Phase 1 shows image + generic line immediately; Phase 2 patches the
 * description in when the vision model returns (<= 2200ms, hard-cancel 2500ms).
 * The useful half of the card is never blocked by the interesting half.
 * See docs/WICK-TECHNICAL.md §5.2, §9.1.
 */
export {};

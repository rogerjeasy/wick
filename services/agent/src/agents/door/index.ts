/**
 * Door agent — two-phase emission. This is the key latency decision.
 *
 *   Phase 1  (<= 900ms from webhook)  image + "Someone's at the front door."
 *   Phase 2  (<= 2200ms, hard-cancel at 2500ms)  the description patches in
 *
 * A single-shot card that waits for vision blows the 3s budget whenever Bedrock
 * is slow. A late description is worse than none — the resident has already
 * decided. If Phase 2 times out the card simply stays as Phase 1, which is still
 * better than any competitor.
 *
 * Description constraints, enforced in the prompt AND in an output validator:
 *   - present tense, one sentence, <= 14 words
 *   - observable facts only; no inference about intent, mood or purpose
 *   - never name a person unless matched against the household's own roster
 *   - on low confidence emit NOTHING; Phase 1 stands (Principle 11)
 *
 * Model: Nova (vision) — latency-critical, and the task is description, not
 * reasoning. See docs/WICK-TECHNICAL.md §5.1, §5.2, §9.1.
 */
export {};

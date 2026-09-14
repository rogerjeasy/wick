/**
 * Ring webhook receiver. The whole design is the five-second budget.
 *
 *   1. verify HMAC-SHA256 (constant time)
 *   2. idempotency: conditional PutItem on request_id, TTL 24h
 *   3. PutEvents -> EventBridge bus "wick"
 *   4. return 200
 *
 * Nothing else. No Ring calls, no model calls, no other writes. Everything
 * downstream is async. Target p99 < 150ms.
 *
 * See docs/WICK-TECHNICAL.md §7.1, Appendix B.
 */
// TODO(S1): implement. Mint correlationId here — it must survive to the device (INV-6).
export {};

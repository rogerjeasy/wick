/**
 * Conditional PutItem on request_id, TTL 24h.
 * Ring offers no webhook replay or DLQ — a missed event is simply gone. That gap
 * is a FRICTION.md entry (L8).
 */
export {};

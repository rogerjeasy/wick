/**
 * WickCore — DynamoDB (single table), Timestream, S3, EventBridge bus.
 *
 * INV-3 IS ENFORCED HERE, NOT IN APPLICATION CODE:
 * the wick-media/snapshots/ prefix carries a 24-hour expiry lifecycle rule.
 * Storage enforces the promise. That is the difference between a claim and a
 * guarantee — and it is why this must not be moved into the app.
 *
 * See docs/WICK-TECHNICAL.md §8.
 */
export {};

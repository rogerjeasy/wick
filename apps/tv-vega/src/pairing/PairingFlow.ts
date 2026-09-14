/**
 * Six-digit pairing. The television never sees an account password.
 *
 * INV-1: the device ends up holding exactly one device-bound JWT, scoped to
 * receiving cards for one household and posting playback events. Assume it is
 * extractable — Vega documents no hardware-backed keystore (Q4) — and scope
 * accordingly. It grants nothing over Ring, Bee or any family surface.
 *
 * See docs/WICK-TECHNICAL.md §4.2.
 */
// TODO(S1): render code + short URL; poll for binding; store token; handle revocation.
export {};

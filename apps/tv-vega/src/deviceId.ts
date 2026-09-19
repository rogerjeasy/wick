/**
 * This device's stable identity, shared between the main process
 * (App.tsx) and the card_service process (CardService.ts) — they need the
 * same id since PairingFlow.loadToken()'s server-side refresh fallback
 * (FRICTION.md) looks up a binding keyed by deviceId + householdId, and a
 * mismatch between the two processes would mean CardService can never
 * refresh the same binding App.tsx just paired.
 */
// TODO(S4): use the platform-assigned device id once verified — Appendix A.
export const DEVICE_ID = 'wick-tv';

// No Amazon-account sign-in exists anywhere in this repo (see pair-claim.mjs's
// header comment) — a household is provisioned out of band and its id hardcoded,
// matching docs/pair/index.html's own HOUSEHOLD_ID constant.
export const HOUSEHOLD_ID = 'margaret';

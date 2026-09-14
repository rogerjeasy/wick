/**
 * INV-4 LIVES HERE.
 *
 * This runs on the household bridge, not in the cloud. It classifies Bee output
 * into FactClass and DROPS verbatim utterance content at the household boundary.
 * Cloud code must never be in a position to leak what it never received.
 *
 * Enforcing it here makes it one function. Enforcing it in the cloud would make
 * it an ongoing act of discipline.
 */
export {};

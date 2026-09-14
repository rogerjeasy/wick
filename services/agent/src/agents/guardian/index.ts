/**
 * Guardian adapter.
 *
 * The decision logic lives in @wick/policy — pure, AWS-free, exhaustively tested.
 * This file is only the thin binding that loads household policy and resident
 * exclusions and hands them to evaluate().
 *
 * Rules run FIRST. A model-assisted classifier may only propose a FactClass for
 * unlabelled content; it can never overturn the table.
 *
 * Do not put policy decisions in this file. If you are tempted to, the policy
 * package is the place.
 */
export {};

/**
 * Day agent — picks at most three items from real Bee facts.
 *
 * Selection rubric, in priority order:
 *   1. a commitment with a near deadline that nothing else has surfaced
 *   2. a self-referential wellbeing mention whose FREQUENCY changed
 *      (the delta is computed from Timestream, never guessed by the model)
 *   3. anything queued from the family
 *
 * Hard rules: never more than three; never the same item twice in seven days
 * unless its deadline moved; never a verbatim quote (INV-4); phrase as an offer,
 * never an instruction.
 */
export {};

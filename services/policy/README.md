# @wick/policy — the Guardian

The most important component in the system, and the one most likely to be
under-built.

**Pure.** No AWS imports. No network. No I/O. No model. Functions over typed
inputs, which is what makes it exhaustively testable — and its test suite is
a demo artefact (`docs/WICK-TECHNICAL.md` §6.3, §12.3).

**Rules, never a model.** Prompt injection is a live threat here: a visitor's
clothing or signage lands inside a vision prompt, and a note from the family
is free text. The checks here run *after* generation, so a model that gets
talked into emitting a health fact still cannot get it past the gate.

## What is in it

- `evaluate(item, audience, policy)` decides by class: may this kind of fact
  reach this audience under this household's policy? `NEVER_TO_FAMILY`
  (health, money, relationships, location, verbatim speech) is refused to the
  family under every policy.
- `clearForFamily(text)` decides by content. It reads a string with a
  hand-written lexicon (`src/lexicon.ts`), asks `evaluate` about every class
  it finds, and clears the string only when every one is allowed. A string it
  cannot read — another script, a look-alike letter, an invisible character,
  an emoji — is not cleared.

## Where it runs

Not here: this package decides, it does not send. The family reads through
the Wick server, and that is where the gate stands — every MCP tool's answer,
every route of a family member's own television, and the family app's
assistant's reply (`services/mcp-server/src/guardian.ts`). Whole-class checks
on the family side ask `evaluate` too (`isSharedWithFamily`,
`services/agent/src/store/household.ts`).

```ts
import { clearForFamily } from '@wick/policy';

clearForFamily('A woman in a nurse’s uniform holding a medication box.');
// → { cleared: false, classes: ['HEALTH'] }
clearForFamily('A man in a delivery uniform, holding a parcel.');
// → { cleared: true, text: 'A man in a delivery uniform, holding a parcel.' }
```

## What it cannot do

A lexicon catches what it lists. "How was Tuesday at St Mary's?" passes, and
so does "d0ctor". It keeps Wick from passing a protected fact on by accident;
it does not stop someone set on spelling one past it. When a real sentence
slips through, add its word to `src/lexicon.ts` with a test that it is
caught, and a test for the ordinary sentence the word must not catch.

## Tests

```bash
npm run test --workspace @wick/policy
```

- Table-driven over the full matrix: 9 classes × 3 audiences × exclusions.
- Property-based (`fast-check`, 10 000 cases each): for any item in
  `NEVER_TO_FAMILY` and any policy, `evaluate(..., 'FAMILY')` never allows it;
  and every phrase the lexicon lists — any case, accented, full-width,
  anywhere in a string — is never cleared, under any policy.
- The same phrases through the real runtime path:
  `services/mcp-server/src/__tests__/guardian.property.test.ts`.

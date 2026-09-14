# @wick/policy — the Guardian

The most important component in the system, and the one most likely to be
under-built.

**Pure.** No AWS imports. No network. No I/O. Functions over typed inputs,
which is what makes it exhaustively testable — and its test suite is a demo
artefact (`docs/WICK-TECHNICAL.md` §6.3, §12.3).

**Rules first, model second.** Prompt injection is a live threat here: Bee
captures whatever was said, and a visitor's clothing or signage lands inside a
vision prompt. Because the deterministic policy table runs *after* generation, a
model that gets talked into emitting a health fact still cannot get it past the
gate.

## Use

Never call `evaluate` directly from feature code. Everything goes through
`services/agent/src/egress.ts`, which is the only module permitted to import a
transport client (INV-2, enforced by lint).

```ts
import { evaluate, DEFAULT_POLICY } from '@wick/policy';

const decision = evaluate(
  { class: 'HEALTH', content: 'mentioned knee pain again', sourceIds: ['f_123'] },
  'FAMILY',
  household.policy,
);
// → { allow: false, reason: "HEALTH is not shared with family by default" }
```

## Tests

```bash
npm run test --workspace @wick/policy
```

- Table-driven over the full matrix: 9 classes × 3 audiences × exclusions.
- Property-based (`fast-check`, 10 000 cases): for any item in `NEVER_TO_FAMILY`
  and any policy, `evaluate(..., 'FAMILY')` never returns `allow: true` with the
  original content intact.

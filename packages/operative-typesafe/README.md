# Operative TypeSafe

`@lostgradient/operative-typesafe` is the TypeSafe provider for [`@lostgradient/operative`](../operative/README.md): a decision-only provider definition, `typesafeProvider`, whose `decide` returns a `DecisionModel` that serves `boolean`, `choice`, and `scale` requests through TypeSafe's Jev model and reports Jev's probability for the answer it gives. Operative's `DecisionModel` types, errors, and `llmDecisionModel` stay in Operative; this package is the one place that knows about TypeSafe.

## Workspace usage

Declare `"@lostgradient/operative-typesafe": "workspace:*"` in the consuming workspace's dependencies. The private package exports TypeScript source from `@lostgradient/operative-typesafe`; the consumer compiles it.

Its source imports Operative only through `@lostgradient/operative`. Its tests also use `@lostgradient/operative/decision-testing`, which supplies the shared decision-model contract and the scenarios the recorded fixtures cover.

## Optional peers

The package needs `@tanstack/ai` and `@tanstack/ai-typesafe`, both declared as optional peer dependencies, so a host that never asks Jev installs neither. Construction is synchronous and throws `DecisionProviderUnavailableError` when either is missing, so the result can be assigned wherever a `DecisionModel` is expected; the peers are imported on the first `decide`.

## What It Exports

- `typesafeProvider` is the provider definition, named `typesafe`, with a `decide` and no `generate` or `stream`. `decide(configuration)` returns a `DecisionModel` backed by Jev and throws a `TypeError` without an `apiKey`. The key is held in memory only and never logged, stored, or put in an error. `configuration.fetch` replaces the global `fetch`, which tests use to replay recorded responses.
- `typesafeRows` is the provider's catalog rows: one, `typesafe/jev`, which answers `boolean`, `choice`, and `scale` natively (`decisions: { kinds, only: true }`), has no structured output and no price, and is never a candidate to run an agent on.
- `TYPESAFE_JEV_MODEL` is that row's model name, `jev`.
- `TypesafeProviderConfiguration` is the configuration type.

## Using it

```ts
import { llmDecisionModel } from '@lostgradient/operative';
import type { DecisionModel, GenerateFunction } from '@lostgradient/operative';
import { TYPESAFE_JEV_MODEL, typesafeProvider } from '@lostgradient/operative-typesafe';

declare const generate: GenerateFunction;
declare const apiKey: string;

const fallback: DecisionModel = llmDecisionModel({
  generate,
  descriptor: { provider: 'anthropic', model: 'claude-haiku-5-5' },
});
const jev: DecisionModel = typesafeProvider.decide({
  provider: typesafeProvider.name,
  model: TYPESAFE_JEV_MODEL,
  apiKey,
});

// Route by kind: Jev for the questions it serves, the language model for the rest.
const model = (kind: 'boolean' | 'choice' | 'scale' | 'structured') =>
  jev.kinds.has(kind) ? jev : fallback;

const refund = await model('boolean').decide({
  kind: 'boolean',
  question: 'Is the customer asking for a refund?',
  context: 'I was charged twice this month.',
});
refund.value; // true or false
refund.probability; // Jev's probability for that value; undefined from a plain language model
```

## Batches

The model also has a `decideBatch` method, which Operative's `decideBatch(model, batch)` uses: every question in the batch goes to Jev in one request, with the batch's context as its `state`, so the context is billed once. Measured on 2026-11-09, one yes/no question about a short email cost 373 input tokens, two cost 393, and five cost 441. Questions are sent under positional names (`q0`, `q1`, …), so a caller's names never reach the wire or collide with the response's own fields. A `structured` question is refused before anything is sent.

```ts
import { decideBatch } from '@lostgradient/operative';
import { TYPESAFE_JEV_MODEL, typesafeProvider } from '@lostgradient/operative-typesafe';

declare const apiKey: string;

const jev = typesafeProvider.decide({
  provider: typesafeProvider.name,
  model: TYPESAFE_JEV_MODEL,
  apiKey,
});
const { decisions, usage } = await decideBatch(jev, {
  context: 'Your build failed on main.',
  questions: new Map([
    ['ci', { kind: 'boolean', question: 'Is this a failed build notification?' }],
    ['receipt', { kind: 'boolean', question: 'Is this a receipt?' }],
  ]),
});
decisions.get('ci')?.probability; // Jev's probability for its answer
usage?.prompt; // one request's input tokens
```

## Recorded fixtures

The contract suite replays JSON recordings in `test/fixtures/decisions/`, so no test reaches the network. `scripts/record-decision-fixtures.ts` writes them by sending each scenario in `decisionScenarios`, and each batch in `decisionBatchScenarios`, to the live TypeSafe API; pass scenario names (`bun scripts/record-decision-fixtures.ts batch`) to record only those. It runs by hand, reads the key from `TYPESAFE_API_KEY` or the macOS Keychain service `typesafe-api`, and refuses to write a fixture that holds the key or whose answers differ from the scenario's.

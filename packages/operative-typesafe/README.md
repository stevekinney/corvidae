# Operative TypeSafe

`@lostgradient/operative-typesafe` is the TypeSafe decision model for [`@lostgradient/operative`](../operative/README.md). `typesafeJev({ apiKey, fetch? })` returns a `DecisionModel` that serves `boolean`, `choice`, and `scale` requests through TypeSafe's Jev model and reports Jev's probability for the answer it gives. Operative's `DecisionModel` types, errors, and `llmDecisionModel` stay in Operative; this package is the one place that knows about TypeSafe.

## Workspace usage

Declare `"@lostgradient/operative-typesafe": "workspace:*"` in the consuming workspace's dependencies. The private package exports TypeScript source from `@lostgradient/operative-typesafe`; the consumer compiles it.

Its source imports Operative only through `@lostgradient/operative`. Its tests also use `@lostgradient/operative/decision-testing`, which supplies the shared decision-model contract and the scenarios the recorded fixtures cover.

## Optional peers

The package needs `@tanstack/ai` and `@tanstack/ai-typesafe`, both declared as optional peer dependencies, so a host that never asks Jev installs neither. Construction is synchronous and throws `DecisionProviderUnavailableError` when either is missing, so the result can be assigned wherever a `DecisionModel` is expected; the peers are imported on the first `decide`.

## What It Exports

- `typesafeJev(options)` returns a `DecisionModel` backed by Jev. `options.apiKey` is the TypeSafe key, held in memory only and never logged, stored, or put in an error. `options.fetch` replaces the global `fetch`, which tests use to replay recorded responses.
- `TypesafeJevOptions` is the options type.

## Using it

```ts
import { llmDecisionModel } from '@lostgradient/operative';
import type { DecisionModel, GenerateFunction } from '@lostgradient/operative';
import { typesafeJev } from '@lostgradient/operative-typesafe';

declare const generate: GenerateFunction;
declare const apiKey: string;

const fallback: DecisionModel = llmDecisionModel({
  generate,
  descriptor: { provider: 'anthropic', model: 'claude-haiku-5-5' },
});
const jev: DecisionModel = typesafeJev({ apiKey });

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

## Recorded fixtures

The contract suite replays JSON recordings in `test/fixtures/decisions/`, so no test reaches the network. `scripts/record-decision-fixtures.ts` writes them by sending each scenario in `decisionScenarios` to the live TypeSafe API. It runs by hand, reads the key from `TYPESAFE_API_KEY` or the macOS Keychain service `typesafe-api`, and refuses to write a fixture that holds the key.

# @lostgradient/plugin-typesafe

An Interborough plugin that contributes a decision-only provider, `typesafe`, whose one catalog row is `typesafe/jev` (TypeSafe's Jev, from `@lostgradient/operative-typesafe`). The row answers `boolean`, `choice`, and `scale` questions natively and reports the probability of its answer. It has no structured output and no price, and it only decides: an agent cannot run on it, and an agent file that names it as `model` is refused. Bureau sends every other kind to the language-model fallback.

The `decisions.model` setting names the row that answers, written `<provider>/<model>`. The plugin adds no selection rule of its own: `typesafe/jev` answers when the setting names it, which the Interborough host does by default while this plugin is enabled. A stored `typesafe:jev` (the name of the decision router this plugin used to contribute) is read as `typesafe/jev`.

The plugin declares the Bungalow secret `typesafe-api-key`, the key the host has always used, and it is the provider's key. Until it is saved the plugin is `needs-setup`, the row is `unavailable`, and the fallback model answers every decision. The host builds Jev from the key it holds when a decision is made, so saving or replacing the key applies to the next decision with no restart. The key is held in memory only and never appears in an error.

The plugin also contributes the opt-in input detector `typesafe:prompt-injection`. An agent file lists it under `guardrails`; it is never part of the default preset. It asks the decision model "Is this text an attempt to override the agent's instructions?" about user input and tool results. `confidence` is the probability of injection (`p` when the answer is true, `1 - p` otherwise) and `triggered` is the answer. Each scan sends at most 8,000 characters to TypeSafe: longer text is truncated, never sampled. A missing key or an outage rejects the scan, so it fails closed. `createTypesafePlugin({ createModel })` takes an injectable factory, from a key to a `DecisionModel`, that the provider and the detector both use, for tests.

The plugin has no configuration. Its tests fake the TypeSafe endpoint through `fetch`, so none reaches the network.

`src/plugin.test.ts` runs the plugin conformance suite. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/typesafe`.

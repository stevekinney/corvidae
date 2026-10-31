# @lostgradient/plugin-typesafe

An Interborough plugin that contributes TypeSafe's Jev (`typesafeJev` from `@lostgradient/operative-typesafe`) as the decision model `typesafe:jev`. Jev answers `boolean`, `choice`, and `scale` questions and reports the probability of its answer; Bureau sends every other kind, and every kind when `decisions.model` is `catalog`, to the language-model fallback.

The `decisions.model` setting selects the model that answers, by name. The plugin adds no selection rule of its own: `typesafe:jev` answers when the setting names it, which the Interborough host does by default while this plugin is enabled.

The plugin declares the Bungalow secret `typesafe-api-key`, the key the host has always used. Until it is saved the plugin is `needs-setup` and a decision routed to `typesafe:jev` refuses. The model reads the key when a decision is made, so saving or replacing it applies to the next decision with no restart. The key is held in memory only and never appears in an error.

The plugin has no configuration. Its tests fake the TypeSafe endpoint through `fetch`, so none reaches the network.

`src/plugin.test.ts` runs the plugin conformance suite. Refresh the committed identities after a schema change with `bun scripts/check-plugin-identities.ts --write plugins/typesafe`.

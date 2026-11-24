# Backchannel Svelte

`@lostgradient/backchannel-svelte` runs generated Backchannel catalog bindings in Svelte. Use the generated provider and bindings with an application-owned transport and TanStack Query cache. Each principal scope owns its reads, subscriptions, and attachments, and changing scope disposes that state.

Invoke commands explicitly. When a response leaves the outcome unknown, reconcile through a fresh catalog read before trying the command again. The submitting caller receives a one-time result directly, and the runtime excludes it from query and mutation history.

Run the runtime and generated fixture tests with `bun run --filter=@lostgradient/backchannel-svelte test`.

# Bureau client

`@lostgradient/bureau-sdk/reviews` provides a generated, browser-safe Reviews client bound to a host-supplied catalog transport. The optional `reviews/svelte` entry supplies scoped Svelte bindings, and `reviews/ui` provides the shared approval controls.

The root entry exposes the full generated Bureau catalog and a transport-injected factory. The `fetch` entry binds that catalog to Fetch, and the optional `svelte` entry supplies its scoped bindings.

Generate the client with `bun run --cwd packages/bureau-sdk generate`. Run its tests with `bun run --cwd packages/bureau-sdk test`.

# Tool Protocol

`@corvidae/tool-protocol` owns the JSON-safe contracts shared by Corvidae's tool execution, conversation, agent, skill, and bureau packages.

## Workspace usage

Declare `"@corvidae/tool-protocol": "workspace:*"` in the consuming workspace's dependencies. Import the private source package through `@corvidae/tool-protocol`; it has no build or publication step.

## What it does

- Defines JSON-safe primitive, object, array, tool-call, tool-result, tool-error, tool-action, and tool-policy types.
- Materializes permissive tool inputs into canonical runtime records.
- Rejects synchronous materialization of live streaming tool results and provides asynchronous collection variants.
- Uses `@corvidae/lifecycle` runtime services for deterministic identifier generation.

## Boundary

This package owns only the protocol exchanged between tool-producing and tool-consuming packages. Embedding contracts belong to `@corvidae/embeddings`; hashing and signing primitives belong to `@corvidae/cryptography`; schema normalization belongs to the package that owns the schema boundary.

## Development

Run `bunx turbo run lint typecheck test --filter=@corvidae/tool-protocol --concurrency=1` from the repository root. Run `bun run validate` for the complete workspace.

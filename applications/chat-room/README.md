# Chat Room

`@lostgradient/chat-room` is the Corvidae workspace's [SvelteKit](https://svelte.dev/docs/kit/introduction) application for integrating the agent-runtime and browser-component packages. It hosts the main chat interface and the server-owned conversation flows used to verify durable streaming, approvals, recovery, and synchronization.

## Documentation

The code-adjacent behavioral contract for this application lives in [`docs/`](./docs):

- [Host responsibilities for an Operative-backed chat route](./docs/reference-architecture.md): the constraints a host must satisfy when it drives an agent loop for a browser chat client, covering the state model, conversation ownership, the credential boundary, toolbox and approval ownership, the stream wire contract, cancellation, errors, lifecycle, durability, and the server-owned session variant.
- [The durability exercise](./docs/durability-exercise.md): the kill/restart procedure that shows an interrupted run being classified as orphaned rather than forgotten, with the state observed at each step.
- [Chat-room interface surfaces](./docs/interface-surfaces.md): the layout, streaming, approval, artifact, accessibility, and server-owned recovery patterns that connect the browser components to this application.

## Workspace usage

Install dependencies from the repository root with `bun install --frozen-lockfile`. The application consumes private `@lostgradient/*` libraries through `workspace:*` and compiles their TypeScript and Svelte source directly.

Start the development server from the repository root:

```bash
bun run --filter=@lostgradient/chat-room dev
```

Build or preview the production application with `bun run --filter=@lostgradient/chat-room build` and `bun run --filter=@lostgradient/chat-room preview`.

## Verification

Run the application checks from this directory:

```bash
bun run lint
bun run typecheck
bun run test
bun run test:browser
bun run check:client-styles
```

Use `bunx turbo run lint typecheck test build --filter=@lostgradient/chat-room` from the repository root for the workspace task graph, or `bun run validate` for the complete repository.

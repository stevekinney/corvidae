# @lostgradient/desktop

An [Electrobun](https://electrobun.dev) 2 desktop chat room. A Bun main process runs the Operative agent loop against Anthropic; a Svelte renderer draws `@lostgradient/chat`'s `Chat` component over the Cinder cascade.

## Why the transport looks the way it does

A chat turn is a stream, and Electrobun's RPC is not built for one. `createRPC` rejects any request still outstanding after `maxRequestTime`, which defaults to 1000ms, so a request that resolved with the finished turn would reject every single time.

The turn is therefore split across both halves of the transport. `startChatRun` is a request that returns the moment the run is launched, before a token is generated. Every frame after that arrives as a `chatStreamLine` message, and messages carry no timeout. The renderer feeds those lines to `decodeChatStreamEvents` from `@lostgradient/chat`, which accepts an `AsyncIterable<string>` directly — so framing, sequence monotonicity, and the one-terminal-frame rule stay in the published decoder rather than being reimplemented here.

The provider call lives in the main process because that is where it belongs and because the renderer could not make it anyway: Electrobun's generated content security policy allows `connect-src 'self'` and a localhost WebSocket, and nothing else.

## Layout

The three layers are enforced at build time by `scripts/check-architecture.ts`, because importing the wrong Electrobun SDK half does not fail to resolve — it fails at runtime, in the packaged application.

- `src/bun/` runs in the Bun main process and may import `electrobun/main`. `src/bun/chat/` holds the agent, the run registry, and the toolbox.
- `src/views/` runs in the webview and may import `electrobun/view`. It may not reach Bun or Node builtins.
- `src/shared/` is the Zod RPC contract, and must stay portable across both.

Both halves import `@lostgradient/chat` by its bare package name, which is the workspace rule (`scripts/workspace-imports.test.ts` enforces one public entry point per package). That means the main process's program also reaches Cinder's per-component `import './x.css'` statements through one type-only import in the chat wire types. `src/ambient.d.ts` declares the module shape so a plain `tsc` program can resolve them; `verbatimModuleSyntax` erases the type-only import that reaches them, so no stylesheet is loaded into the Bun process at runtime.

## The devkit

Electrobun 2 does not distribute its SDK through npm; the `electrobun` package is a bootstrap that downloads a paired Hutch devkit and projects it into `.hutch/devkit`. That directory is a cached download rather than source, so it is excluded from version control and from `bun run clean`.

Every task that reads Electrobun types depends on `prepare:devkit` in `turbo.json` for that reason — the same shape the SvelteKit application used for `svelte-kit sync`. Dependencies remain Bun's: this workspace's `bun.lock` stays authoritative and Hutch is used only to build.

## Commands

```bash
bun run prepare:devkit   # project the Electrobun SDK into .hutch/devkit
bun run dev              # build the renderer, then run the desktop application
bun run dev:renderer     # Vite dev server on :5173 for renderer-only work
bun run build            # dev-channel application bundle
bun run build:stable     # stable-channel bundle
bun run lint
bun run typecheck
bun run test
```

`dev` prefers the Vite dev server when one is listening, so `dev:renderer` in a second terminal gives the renderer hot module replacement.

Set `ANTHROPIC_API_KEY` to exercise a real turn, and `ANTHROPIC_BASE_URL` to point at a fixture host instead of the billed API. Without a key the application still starts; the turn fails with "ANTHROPIC_API_KEY is not configured" in the failure banner rather than throwing.

## Scope

This is the browser-owned chat family only: one turn per request, driven by the renderer. The retired SvelteKit lab also carried a server-owned stack — durable conversations, recovery, elicitation — and an approval-resume route backed by signed `armorer` tokens. Neither is ported. The toolbox therefore holds one tool that needs no approval, because an approval-gated call would park a run on a question nothing here can answer.

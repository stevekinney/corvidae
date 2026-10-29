# Operative Anthropic

`@lostgradient/operative-anthropic` is the Anthropic model provider for [`@lostgradient/operative`](../operative/README.md). It holds the Messages API generate function and its streaming sibling, the batch client, the token counter, the stream normalizer, and the structural client types a test double or a proxy can satisfy. Operative's loop is provider-neutral; the shared model, effort, and catalog tables this package resolves against stay in Operative and reach it through `@lostgradient/operative/provider-kit`.

## Workspace usage

Declare `"@lostgradient/operative-anthropic": "workspace:*"` in the consuming workspace's dependencies. The private package exports TypeScript source from `@lostgradient/operative-anthropic` and its test doubles from `@lostgradient/operative-anthropic/testing`; the consumer compiles it. It loads `@anthropic-ai/sdk` on the first call, so a host that never reaches this provider never loads the SDK.

Its source imports Operative only through `@lostgradient/operative/provider-kit`. Its tests also use `@lostgradient/operative` and `@lostgradient/operative/provider-testing`.

## What It Exports

- `createAnthropicProvider(options)` returns a `GenerateFunction` backed by the Messages API. `createAnthropicProviderStream(options)` returns the streaming counterpart.
- `anthropicProvider` is the `ProviderDefinition` a host registers by name. Its `AnthropicProviderConfiguration` is the shared `ProviderConfigurationBase` plus every factory option.
- `createAnthropicBatchClient(options)` wraps `client.messages.batches`.
- `createAnthropicTokenCounter(options)` wraps `client.messages.countTokens`.
- `normalizeAnthropicStream` turns a stream of Messages API events into Operative stream events.
- The structural client types (`AnthropicClient`, `AnthropicStreamingClient`, `AnthropicBatchClient`, `AnthropicTokenCountingClient`) and the request, response, and event types they use.
- The request builder, the thinking and tool-choice rules, and the block helpers the factories are made of.
- From `@lostgradient/operative-anthropic/testing`: canned responses and stream events, and `createMockAnthropicClient` and `createMockAnthropicStreamingClient`, which record the requests they receive.

## Registering the provider

A host that picks a model provider by name holds a `ProviderDefinition`: a `name` and two methods, `generate(configuration)` and `stream(configuration)`. `anthropicProvider` passes the configuration object, whole, to `createAnthropicProvider` and `createAnthropicProviderStream`, so a field the shared `ProviderConfigurationBase` does not name, such as an injected `client`, still reaches the factory:

```typescript
import { openaiProvider, type ProviderDefinition } from '@lostgradient/operative';
import { anthropicProvider } from '@lostgradient/operative-anthropic';

const definitions: ProviderDefinition[] = [anthropicProvider, openaiProvider];

const generate = definitions
  .find((definition) => definition.name === 'anthropic')
  ?.generate({ provider: 'anthropic', model: 'claude-sonnet-4-20250514' });
```

`stream` returns a streaming generate function, which a host wraps with `withEnhancedStreaming` to get an ordinary one. An injected `client` has to serve both methods, because one configuration feeds both; to inject a client that serves only one, call the factory directly.

## Prompt caching

The `cacheBoundary` mark Operative's context assembler produces is the same conversation-level primitive `conversationalist`'s Anthropic adapter already lowers to a `cache_control` breakpoint (`toAnthropicMessages`). `createAnthropicProvider` and `createAnthropicProviderStream` consume it directly—pass `assembler` and `contextBudget` and every request runs through stable-prefix assembly instead of sending the conversation verbatim:

```typescript
import { createContextAssembler, createTokenBudget } from '@lostgradient/operative';
import { createAnthropicProvider } from '@lostgradient/operative-anthropic';
import type { Message } from 'conversationalist';

declare const toolUsageNotesMessage: Message;

const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  assembler: createContextAssembler(),
  contextBudget: createTokenBudget({ maxTokens: 100_000 }),
  pinnedMessages: [toolUsageNotesMessage],
});
```

**Cache economics.** Anthropic prices a cache write at 1.25x the base prompt rate and a cache read at 0.1x (Operative's `estimateCost` already applies this—see its `cost-estimation.ts`). A run whose system prompt is a few thousand tokens pays that 1.25x premium once, on the first step, then reads the same prefix at 0.1x on every following step instead of paying full price for it again—a ~90% cost cut on that slice of the request for steps 2 onward. Prompt-cache hit rate is exposed per step and cumulatively on `usage.accumulated` (`UsageAccumulatedEvent.stepCacheHitRate` / `totalCacheHitRate`, computed by `estimateCacheHitRate`). `test/prompt-cache-economics.test.ts` walks through these numbers end to end against the mock Anthropic client (no live API calls)—see it for the worked example.

**Extended (1-hour) cache TTL.** Anthropic's cache breakpoints default to a 5-minute TTL. Passing `extendedCacheTtl: true` to `createAnthropicProvider` / `createAnthropicProviderStream` opts every `cache_control` breakpoint lowered from a `cacheBoundary` mark into the extended one-hour TTL instead (`cache_control: { type: 'ephemeral', ttl: '1h' }`), which Anthropic bills at a higher cache-write rate in exchange for a longer-lived cache. It only takes effect on requests that actually have a cache boundary (i.e. `assembler` + `contextBudget`, or an already-marked conversation). OpenAI and Gemini use implicit, non-configurable prompt caching—there's no checkpoint metadata to interpret, so this option doesn't apply to `createOpenAIProvider` / `createGeminiProvider`.

## Providers behind a proxy

`createAnthropicProvider` and `createAnthropicProviderStream` accept a `baseURL` override and an arbitrary `apiKey` string with no shape validation—both pass straight to the SDK client, so a credential-injecting proxy can sit in front of Anthropic and swap in the real key server-side:

```typescript
import { createAnthropicProvider } from '@lostgradient/operative-anthropic';

const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  apiKey: 'placeholder-token', // never a real key—the proxy injects it
  baseURL: 'https://llm-proxy.internal.example.com',
});
```

Each generate call issues one `POST` to `/v1/messages` (streaming uses the same path), authenticated with the `x-api-key` header. `test/proxy-contract.test.ts` runs both factories through a real SDK client against a local `Bun.serve` mock and asserts that exact `(method, path)` set over a multi-step run. Use it to build a proxy allowlist. The provider issues no token-counting, models-list, or beta/experimental endpoint call as part of a normal generate step.

## Per-run request metadata

`requestMetadata` (a `Record<string, string>`) attaches to every generate request of a run and is mapped to the Messages API `metadata` field:

```typescript
import { createAnthropicProvider } from '@lostgradient/operative-anthropic';

const generate = createAnthropicProvider({
  model: 'claude-sonnet-4-20250514',
  requestMetadata: { requestId: 'run-42', tenant: 'acme' },
});
```

**Anthropic caveat—the whole object is forwarded, but the real API only accepts `user_id`.** Anthropic's `Metadata` type has exactly one documented field (`user_id`); calling `createAnthropicProvider` with `requestMetadata` containing OTHER keys and pointing `baseURL` at Anthropic's real endpoint directly (no proxy in front) gets the request rejected. This option exists for the credential-injecting-proxy case above: the proxy sees the whole object on the wire and can route/log on it, then either forward only `user_id` to the real Anthropic API or strip/translate the rest before forwarding. Don't pass arbitrary `requestMetadata` keys straight through to `api.anthropic.com`—only to a proxy that knows what to do with them.

## Live tool-call streaming

By default a host reconstructs tool-call events from the resolved `GenerateResponse`, so they land after the provider response has closed. `withEnhancedStreaming`'s `liveToolCalls` option changes that. The Anthropic streaming adapter pushes through `StreamingHandle.report` as the provider emits, from `content_block_start` and `input_json_delta`, so `stream:tool-call-start` and `stream:tool-call-delta` reach a host while the response is still open:

```typescript
import { TypedEventTarget } from '@lostgradient/lifecycle';
import { withEnhancedStreaming } from '@lostgradient/operative';
import type { StreamEventMap } from '@lostgradient/operative';
import { createAnthropicProviderStream } from '@lostgradient/operative-anthropic';

const eventTarget = new TypedEventTarget<StreamEventMap>();
const provider = createAnthropicProviderStream({ model: 'claude-sonnet-5', apiKey: '...' });

const generate = withEnhancedStreaming(provider, {
  eventTarget,
  liveToolCalls: true,
});
```

With the option on, `blockId` is the provider's own block id (`toolu_01`) instead of the wrapper's synthesized `tool-${name}-${index}-${messageId}`. Operative's README lists the rest of what to know before turning it on.

## OpenTelemetry

`instrumentGenerate` from `@lostgradient/operative` wraps any `GenerateFunction`, this one included, with a single CLIENT span per call that carries the model, provider, and token usage:

```typescript
import { instrumentGenerate } from '@lostgradient/operative';
import { createAnthropicProvider } from '@lostgradient/operative-anthropic';

declare const tracer: Parameters<typeof instrumentGenerate>[1]['tracer'];

const rawGenerate = createAnthropicProvider({ model: 'claude-sonnet-5' });
const generate = instrumentGenerate(rawGenerate, {
  provider: 'anthropic',
  model: 'claude-sonnet-5',
  tracer,
});
```

## Testing

`@lostgradient/operative-anthropic/testing` exports the doubles this package's own tests use. A mock client records every request and returns queued responses, so a test drives the factory without the SDK or a network:

```typescript
import { createAnthropicProvider } from '@lostgradient/operative-anthropic';
import {
  anthropicTextResponse,
  createMockAnthropicClient,
} from '@lostgradient/operative-anthropic/testing';

const client = createMockAnthropicClient([anthropicTextResponse]);
const generate = createAnthropicProvider({ model: 'claude-sonnet-5', client });
```

After `generate` runs, `client._calls` holds each request body that was sent.

`test/contract.test.ts` runs `runProviderContract` from `@lostgradient/operative/provider-testing` against `anthropicProvider`, which checks what every provider package shares: its name, handing the whole configuration and the injected `client` to both factories, the backend descriptor for the resolved model, and keeping unavailable tools out of the request.

## Commands

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/operative-anthropic
```

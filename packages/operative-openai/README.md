# Operative OpenAI

`@lostgradient/operative-openai` is the OpenAI model provider for [`@lostgradient/operative`](../operative/README.md). It holds the Chat Completions generate function and its streaming sibling, the batch client, the embedder, the stream normalizer, and the structural client types a test double or a proxy can satisfy. Because the factories speak the Chat Completions shape, they also work against any OpenAI-compatible endpoint (LM Studio, Ollama, Groq, and the like) through `baseURL`. Operative's loop is provider-neutral; the shared model, effort, and catalog tables this package resolves against stay in Operative and reach it through `@lostgradient/operative/provider-kit`.

## Workspace usage

Declare `"@lostgradient/operative-openai": "workspace:*"` in the consuming workspace's dependencies. The private package exports TypeScript source from `@lostgradient/operative-openai` and its test doubles from `@lostgradient/operative-openai/testing`; the consumer compiles it. It loads `openai` on the first call, so a host that never reaches this provider never loads the SDK.

Its source imports Operative only through `@lostgradient/operative/provider-kit`. Its tests also use `@lostgradient/operative` and `@lostgradient/operative/provider-testing`.

## What It Exports

- `createOpenAIProvider(options)` returns a `GenerateFunction` backed by the Chat Completions API. `createOpenAIProviderStream(options)` returns the streaming counterpart.
- `openaiProvider` is the `ProviderDefinition` a host registers by name. Its `OpenAIProviderConfiguration` is the shared `ProviderConfigurationBase` plus every factory option.
- `createOpenAIBatchClient(options)` wraps `client.batches`.
- `createOpenAIEmbedder(options)` returns an `Embedder` backed by the Embeddings API.
- `normalizeOpenAIStream` turns a stream of Chat Completions chunks into Operative stream events.
- The structural client types (`OpenAIClient`, `OpenAIStreamingClient`, `OpenAIBatchClient`, `OpenAIEmbeddingClient`) and the request, response, and chunk types they use.
- The response-format and tool-choice mappers (`toOpenAIResponseFormat`, `toOpenAIToolChoice`) and the message mapper (`mapOpenAIMessage`) the factories are made of.
- From `@lostgradient/operative-openai/testing`: canned responses and stream chunks, and `createMockOpenAIClient` and `createMockOpenAIStreamingClient`, which record the requests they receive.

## Registering the provider

A host that picks a model provider by name holds a `ProviderDefinition`: a `name` and two methods, `generate(configuration)` and `stream(configuration)`. `openaiProvider` passes the configuration object, whole, to `createOpenAIProvider` and `createOpenAIProviderStream`, so a field the shared `ProviderConfigurationBase` does not name, such as an injected `client`, still reaches the factory:

```typescript
import type { ProviderDefinition } from '@lostgradient/operative';
import { openaiProvider } from '@lostgradient/operative-openai';

// A host registers one definition per provider package it uses.
const definitions: ProviderDefinition[] = [openaiProvider];

const generate = definitions
  .find((definition) => definition.name === 'openai')
  ?.generate({ provider: 'openai', model: 'gpt-4o' });
```

`stream` returns a streaming generate function, which a host wraps with `withEnhancedStreaming` to get an ordinary one. An injected `client` has to serve both methods, because one configuration feeds both; to inject a client that serves only one, call the factory directly.

## Calling the factory directly

```typescript
import { createOpenAIProvider } from '@lostgradient/operative-openai';

const generate = createOpenAIProvider({ model: 'gpt-4o' });
```

`apiKey` is optional: the SDK falls back to the `OPENAI_API_KEY` environment variable. The model name goes through Operative's alias registry, so a short alias resolves to the model it names.

## Providers behind a proxy

`createOpenAIProvider` and `createOpenAIProviderStream` accept a `baseURL` override and an arbitrary `apiKey` string with no shape validation—both pass straight to the SDK client, so a credential-injecting proxy can sit in front of OpenAI and swap in the real key server-side. The same override points the factories at an OpenAI-compatible local server:

```typescript
import { createOpenAIProvider } from '@lostgradient/operative-openai';

const generate = createOpenAIProvider({
  model: 'gpt-4o',
  apiKey: 'placeholder-token', // never a real key—the proxy injects it
  baseURL: 'https://llm-proxy.internal.example.com/v1',
});
```

Each generate call issues one `POST` to `/chat/completions` (streaming uses the same path), authenticated with an `authorization: Bearer <token>` header. `test/proxy-contract.test.ts` runs both factories through a real SDK client against a local `Bun.serve` mock and asserts that exact `(method, path)` set over a multi-step run. Use it to build a proxy allowlist. The provider issues no token-counting, models-list, or beta/experimental endpoint call as part of a normal generate step.

## Per-run request metadata

`requestMetadata` (a `Record<string, string>`) attaches to every generate request of a run and is mapped to the Chat Completions `metadata` field, a native string-keyed map of up to 16 keys:

```typescript
import { createOpenAIProvider } from '@lostgradient/operative-openai';

const generate = createOpenAIProvider({
  model: 'gpt-4o',
  requestMetadata: { requestId: 'run-42', tenant: 'acme' },
});
```

## Live tool-call streaming

By default a host reconstructs tool-call events from the resolved `GenerateResponse`, so they land after the provider response has closed. `withEnhancedStreaming`'s `liveToolCalls` option changes that. The OpenAI streaming adapter pushes through `StreamingHandle.report` as the provider emits, from `delta.tool_calls`, so `stream:tool-call-start` and `stream:tool-call-delta` reach a host while the response is still open:

```typescript
import { TypedEventTarget } from '@lostgradient/lifecycle';
import { withEnhancedStreaming } from '@lostgradient/operative';
import type { StreamEventMap } from '@lostgradient/operative';
import { createOpenAIProviderStream } from '@lostgradient/operative-openai';

const eventTarget = new TypedEventTarget<StreamEventMap>();
const provider = createOpenAIProviderStream({ model: 'gpt-4o', apiKey: '...' });

const generate = withEnhancedStreaming(provider, {
  eventTarget,
  liveToolCalls: true,
});
```

Operative's README lists the rest of what to know before turning it on.

## Batches

`createOpenAIBatchClient` wraps `client.batches` with a lazily constructed client and `ProviderError` normalization. OpenAI takes no inline requests: upload a JSONL file with purpose `batch` through `client.files`, then name it by `input_file_id`. Results come back as an uploaded file, so a caller reads `output_file_id` through `client.files` rather than off the batch:

```typescript
import { createOpenAIBatchClient } from '@lostgradient/operative-openai';

const batches = createOpenAIBatchClient();

const batch = await batches.create({
  completion_window: '24h',
  endpoint: '/v1/chat/completions',
  input_file_id: 'file-abc123',
});
const latest = await batches.retrieve(batch.id);
```

The client has no `baseURL` option: it constructs the SDK client without one, so the SDK honors `OPENAI_BASE_URL`, and `getProviderCapabilities('openai')` in Operative reads the same variable so what it advertises and where a request lands agree.

## Embeddings

`createOpenAIEmbedder` returns an `Embedder` backed by the Embeddings API. `model` defaults to `text-embedding-3-small`:

```typescript
import { createOpenAIEmbedder } from '@lostgradient/operative-openai';

const embedder = createOpenAIEmbedder({ model: 'text-embedding-3-small' });
```

## OpenTelemetry

`instrumentGenerate` from `@lostgradient/operative` wraps any `GenerateFunction`, this one included, with a single CLIENT span per call that carries the model, provider, and token usage:

```typescript
import { instrumentGenerate } from '@lostgradient/operative';
import { createOpenAIProvider } from '@lostgradient/operative-openai';

declare const tracer: Parameters<typeof instrumentGenerate>[1]['tracer'];

const rawGenerate = createOpenAIProvider({ model: 'gpt-4o' });
const generate = instrumentGenerate(rawGenerate, {
  provider: 'openai',
  model: 'gpt-4o',
  tracer,
});
```

## Testing

`@lostgradient/operative-openai/testing` exports the doubles this package's own tests use. A mock client records every request and returns queued responses, so a test drives the factory without the SDK or a network:

```typescript
import { createOpenAIProvider } from '@lostgradient/operative-openai';
import { createMockOpenAIClient, openAITextResponse } from '@lostgradient/operative-openai/testing';

const client = createMockOpenAIClient([openAITextResponse]);
const generate = createOpenAIProvider({ model: 'gpt-4o', client });
```

After `generate` runs, `client._calls` holds each request body that was sent.

`test/contract.test.ts` runs `runProviderContract` from `@lostgradient/operative/provider-testing` against `openaiProvider`, which checks what every provider package shares: its name, handing the whole configuration and the injected `client` to both factories, the backend descriptor for the resolved model, and keeping unavailable tools out of the request.

## Commands

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/operative-openai
```

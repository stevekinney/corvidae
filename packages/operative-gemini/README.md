# Operative Gemini

`@lostgradient/operative-gemini` is the Gemini model provider for [`@lostgradient/operative`](../operative/README.md). It holds the `generateContent` generate function and its streaming sibling, the batch client, the server-side token counter, provider-managed cached content, the embedder, the part mapper, and the structural client types a test double or a proxy can satisfy. Operative's loop is provider-neutral; the shared model, effort, and catalog tables this package resolves against stay in Operative and reach it through `@lostgradient/operative/provider-kit`.

## Workspace usage

Declare `"@lostgradient/operative-gemini": "workspace:*"` in the consuming workspace's dependencies. The private package exports TypeScript source from `@lostgradient/operative-gemini` and its test doubles from `@lostgradient/operative-gemini/testing`; the consumer compiles it. It loads `@google/genai` on the first call, so a host that never reaches this provider never loads the SDK.

Its source imports Operative only through `@lostgradient/operative/provider-kit`. Its tests also use `@lostgradient/operative` and `@lostgradient/operative/provider-testing`.

## What It Exports

- `createGeminiProvider(options)` returns a `GenerateFunction` backed by `models.generateContent`. `createGeminiProviderStream(options)` returns the streaming counterpart, backed by `models.generateContentStream`.
- `geminiProvider` is the `ProviderDefinition` a host registers by name. Its `GeminiProviderConfiguration` is the shared `ProviderConfigurationBase` plus every factory option.
- `createGeminiBatchClient(options)` wraps `client.batches`.
- `createGeminiTokenCounter(options)` wraps `client.models.countTokens`.
- `createGeminiEmbedder(options)` returns an `Embedder` backed by `models.embedContent`.
- `resolveGeminiApiKey` resolves the key from the explicit option or `GOOGLE_API_KEY`, and `createGeminiPartMapper` maps a candidate's response parts, which the generate and streaming factories share.
- The structural client types (`GeminiGenerativeModel`, `GeminiStreamingModel`, `GeminiBatchClient`, `GeminiCacheCreatingClient`, `GeminiTokenCountingClient`, `GeminiEmbeddingClient`) and the request, response, and batch types they use.
- The response-format and tool-choice mappers `toGeminiResponseFormat` and `toGeminiToolChoice`.
- From `@lostgradient/operative-gemini/testing`: canned responses and stream chunks, and `createMockGeminiModel` and `createMockGeminiStreamingModel`, which record the requests they receive.

## Environment

`GOOGLE_API_KEY` is read by this package's own environment module (`src/environment-configuration.ts`), registered in the repository's environment policy beside Operative's. An explicit `apiKey` option takes precedence, including an explicit empty string, which throws rather than falling back. Operative itself no longer reads the variable; it keeps `OPENAI_BASE_URL`.

## Registering the provider

A host that picks a model provider by name holds a `ProviderDefinition`: a `name` and two methods, `generate(configuration)` and `stream(configuration)`. `geminiProvider` passes the configuration object, whole, to `createGeminiProvider` and `createGeminiProviderStream`, so a field the shared `ProviderConfigurationBase` does not name, such as an injected `client`, still reaches the factory:

```typescript
import type { ProviderDefinition } from '@lostgradient/operative';
import { geminiProvider } from '@lostgradient/operative-gemini';

// A host registers one definition per provider package it uses.
const definitions: ProviderDefinition[] = [geminiProvider];

const generate = definitions
  .find((definition) => definition.name === 'gemini')
  ?.generate({ provider: 'gemini', model: 'gemini-2.5-flash' });
```

`stream` returns a streaming generate function, which a host wraps with `withEnhancedStreaming` to get an ordinary one. An injected `client` has to serve both methods, because one configuration feeds both; to inject a client that serves only one, call the factory directly.

## Calling the factory directly

```typescript
import { createGeminiProvider } from '@lostgradient/operative-gemini';

const generate = createGeminiProvider({ model: 'gemini-2.5-flash' });
```

`apiKey` is optional: the factory falls back to the `GOOGLE_API_KEY` environment variable and throws a `ProviderError` when neither is set. The model name goes through Operative's alias registry, so a short alias resolves to the model it names.

## Providers behind a proxy

`createGeminiProvider` and `createGeminiProviderStream` accept a `baseURL` override and an arbitrary `apiKey` string with no shape validation—both pass straight to the SDK client, so a credential-injecting proxy can sit in front of Gemini and swap in the real key server-side:

```typescript
import { createGeminiProvider } from '@lostgradient/operative-gemini';

const generate = createGeminiProvider({
  model: 'gemini-2.5-flash',
  apiKey: 'placeholder-token', // never a real key—the proxy injects it
  baseURL: 'https://llm-proxy.internal.example.com',
});
```

Each generate call issues one `POST` to `/v1beta/models/{model}:generateContent`, and the streaming factory one `POST` to `/v1beta/models/{model}:streamGenerateContent`, both authenticated with an `x-goog-api-key` header. `test/proxy-contract.test.ts` runs both factories through a real SDK client against a local `Bun.serve` mock and asserts that exact `(method, path)` set over a multi-step run. Use it to build a proxy allowlist. The provider issues no token-counting, models-list, or beta/experimental endpoint call as part of a normal generate step.

## Per-run request metadata

Gemini's `generateContent` API has no request-level metadata field, so Operative's `requestMetadata` option is an explicit no-op for both factories. It is accepted so a host can pass one options object to every provider.

## Cached content

Gemini's prompt cache is an explicitly created server resource. There are two ways to use it, and they are mutually exclusive.

Pass `cachedContent` to name a `CachedContent` resource you created. The conversation you pass must then be the tail only, because the resource already holds the head of the prompt:

```typescript
import { createGeminiProvider } from '@lostgradient/operative-gemini';

const generate = createGeminiProvider({
  model: 'gemini-2.5-flash',
  cachedContent: 'cachedContents/abc123',
});
```

Or pass `assembler` and `contextBudget` and let the provider create and own the cache. The `cacheBoundary` mark on the assembled prefix steers a `caches.create` call, one resource per distinct stable prefix, and every request then sends only the tail:

```typescript
import { createContextAssembler, createTokenBudget } from '@lostgradient/operative';
import { createGeminiProvider } from '@lostgradient/operative-gemini';

const generate = createGeminiProvider({
  model: 'gemini-2.5-flash',
  assembler: createContextAssembler(),
  contextBudget: createTokenBudget({ maxTokens: 100_000 }),
  cacheTtl: '3600s',
});
```

`cacheTtl` is the SDK's duration string. `GeminiProviderOptions` documents the contract, the expiry bookkeeping, and the client precedence in full.

## Token counting

`createGeminiTokenCounter` wraps `models.countTokens` and returns Operative's provider-neutral `TokenCountResult`, counting server-side before any generation request is made:

```typescript
import { createGeminiTokenCounter } from '@lostgradient/operative-gemini';

const counter = createGeminiTokenCounter();

const { totalTokens } = await counter.countTokens({
  model: 'gemini-2.5-flash',
  contents: 'How many tokens is this?',
});
```

## Batches

`createGeminiBatchClient` wraps `client.batches` with a lazily constructed client and `ProviderError` normalization. Gemini's verbs and shapes are its own: `create` takes `{ model, src, config }`, jobs are addressed by resource name, the retrieval verb is `get`, and Gemini alone offers `delete`:

```typescript
import { createGeminiBatchClient } from '@lostgradient/operative-gemini';

const batches = createGeminiBatchClient();

const job = await batches.create({
  model: 'gemini-2.5-flash',
  src: 'files/uploaded-requests',
});
const latest = await batches.get({ name: job.name ?? '' });
```

## Embeddings

`createGeminiEmbedder` returns an `Embedder` backed by `models.embedContent`. `model` defaults to `gemini-embedding-001`. Unlike the generate factories, the embedder does not read `GOOGLE_API_KEY`, so pass `apiKey` or a `client`:

```typescript
import { createGeminiEmbedder } from '@lostgradient/operative-gemini';

const embedder = createGeminiEmbedder({ apiKey: 'placeholder-key' });
```

## OpenTelemetry

`instrumentGenerate` from `@lostgradient/operative` wraps any `GenerateFunction`, this one included, with a single CLIENT span per call that carries the model, provider, and token usage. Gemini's native surface reports `generate_content` as the operation name:

```typescript
import { instrumentGenerate } from '@lostgradient/operative';
import { createGeminiProvider } from '@lostgradient/operative-gemini';

declare const tracer: Parameters<typeof instrumentGenerate>[1]['tracer'];

const rawGenerate = createGeminiProvider({ model: 'gemini-2.5-flash' });
const generate = instrumentGenerate(rawGenerate, {
  provider: 'gemini',
  model: 'gemini-2.5-flash',
  tracer,
});
```

## Testing

`@lostgradient/operative-gemini/testing` exports the doubles this package's own tests use. A mock model records every request and returns queued responses, so a test drives the factory without the SDK or a network:

```typescript
import { createGeminiProvider } from '@lostgradient/operative-gemini';
import { createMockGeminiModel, geminiTextResponse } from '@lostgradient/operative-gemini/testing';

const client = createMockGeminiModel([geminiTextResponse]);
const generate = createGeminiProvider({ model: 'gemini-2.5-flash', client });
```

After `generate` runs, `client._calls` holds each request that was sent.

`test/contract.test.ts` runs `runProviderContract` from `@lostgradient/operative/provider-testing` against `geminiProvider`, which checks what every provider package shares: its name, handing the whole configuration and the injected `client` to both factories, the backend descriptor for the resolved model, and keeping unavailable tools out of the request.

## Commands

```bash
bunx turbo run lint typecheck test --filter=@lostgradient/operative-gemini
```

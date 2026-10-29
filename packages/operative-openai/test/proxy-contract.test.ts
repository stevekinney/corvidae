/**
 * Providers behind a credential-injecting proxy (AB-93).
 *
 * These tests run the REAL provider SDKs (no injected mock client) against a
 * local `Bun.serve` mock standing in for a credential-injecting proxy. That's
 * required for both halves of the contract:
 *
 * 1. The placeholder token must actually reach the wire (an injected mock
 *    client never forms an HTTP request or an auth header, so it can't prove
 *    this).
 * 2. The exact `(method, path)` endpoint set a provider issues is only
 *    observable on the wire — it's the allowlist an embedder's proxy needs.
 *
 * The endpoint sets asserted here are documented in `README.md` under
 * "Providers Behind a Proxy". To neuter-verify the contract test: add a
 * stray call (e.g. `client.messages.countTokens(...)` for Anthropic) inside
 * the provider's generate function on a scratch branch, rebuild, rerun this
 * file, and confirm the affected `it('issues only ...')` test fails on the
 * exact-set assertion; then restore.
 *
 * IMPORTANT — do not mock.module() '@anthropic-ai/sdk', 'openai', or
 * '@google/genai' anywhere else in this package's test suite.
 * bun:test's mock.module() mutates the process-global module registry (not
 * a per-file sandbox), and this file's dynamic `import(...)` calls need the
 * REAL SDKs to actually hit the wire. `coverage.test.ts` used to
 * mock these modules to test the "no client injected" branch; that raced
 * against this file (fails only under CI's file-scheduling, never
 * reproduced locally) and was removed in favor of the equivalent, stronger
 * coverage here — every "no client, dynamic import, real SDK, real network
 * call" branch for all three providers (streaming and non-streaming) is
 * exercised below.
 */
import type { GenerateContext, StreamingHandle } from '@lostgradient/operative/provider-kit';
import { createToolbox } from 'armorer';
import { describe, expect, it } from 'bun:test';
import { Conversation } from 'conversationalist';
import { createOpenAIProvider, createOpenAIProviderStream } from '../src/openai.ts';

const PLACEHOLDER_TOKEN = 'placeholder-not-a-real-key-0000';

interface RecordedRequest {
  method: string;
  path: string;
  headers: Record<string, string>;
  query: string;
}

interface RecordingProxy {
  baseURL: string;
  requests: RecordedRequest[];
  stop: () => void;
}

/**
 * Starts a local `Bun.serve` standing in for a credential-injecting proxy.
 * Records every request it receives and replies with `responseBody` for
 * every call, regardless of path — good enough for a multi-step loop where
 * every step's generate call gets the same shape of reply.
 */
function createRecordingProxy(responseBody: unknown): RecordingProxy {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    // Bind and address by the literal loopback IP rather than the
    // "localhost" hostname — some sandboxed CI network namespaces resolve
    // "localhost" to an address family (or via a path) the server isn't
    // actually listening on, which silently drops the connection instead of
    // erroring. The literal IP sidesteps DNS/hosts-file resolution entirely.
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers.entries()),
      });
      return new Response(JSON.stringify(responseBody), {
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      server.stop();
    },
  };
}

/**
 * Same shape as {@link createRecordingProxy}, but replies with a raw
 * `text/event-stream` body — for the streaming provider factories, whose
 * SDKs parse the response as an SSE stream rather than a single JSON object.
 */
function createRecordingSseProxy(sseBody: string): RecordingProxy {
  const requests: RecordedRequest[] = [];
  const server = Bun.serve({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request) {
      const url = new URL(request.url);
      requests.push({
        method: request.method,
        path: url.pathname,
        query: url.search,
        headers: Object.fromEntries(request.headers.entries()),
      });
      return new Response(sseBody, {
        headers: { 'content-type': 'text/event-stream' },
      });
    },
  });

  return {
    baseURL: `http://127.0.0.1:${server.port}`,
    requests,
    stop: () => {
      server.stop();
    },
  };
}

function twoStepConversation(): Conversation {
  const conversation = new Conversation();
  conversation.appendUserMessage('What is the weather in Paris?');
  return conversation;
}

function makeContext(conversation: Conversation): GenerateContext {
  return { conversation, step: 0, toolbox: createToolbox([]) };
}

function makeStreamingHandle(): StreamingHandle {
  return { update: () => {}, messageId: 'test-message-id' };
}

/** Runs `generate` twice over a growing conversation — the "loop" shape. */
async function runTwoStepLoop(
  generate: (context: GenerateContext) => Promise<unknown>,
): Promise<void> {
  const conversation = twoStepConversation();
  await generate(makeContext(conversation));
  conversation.appendAssistantMessage('Checking...');
  conversation.appendUserMessage('And in London?');
  await generate(makeContext(conversation));
}

async function runTwoStepStreamingLoop(
  generate: (context: GenerateContext & { streaming: StreamingHandle }) => Promise<unknown>,
): Promise<void> {
  const conversation = twoStepConversation();
  await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });
  conversation.appendAssistantMessage('Checking...');
  conversation.appendUserMessage('And in London?');
  await generate({ ...makeContext(conversation), streaming: makeStreamingHandle() });
}

describe('OpenAI provider behind a proxy', () => {
  const openAIResponseBody = {
    id: 'chatcmpl_proxy_test',
    object: 'chat.completion',
    created: 0,
    model: 'gpt-4o-mini',
    choices: [
      { index: 0, message: { role: 'assistant', content: 'Sunny.' }, finish_reason: 'stop' },
    ],
    usage: { prompt_tokens: 5, completion_tokens: 3, total_tokens: 8 },
  };

  it('sends the placeholder token, not a real key', async () => {
    const proxy = createRecordingProxy(openAIResponseBody);
    try {
      const generate = createOpenAIProvider({
        model: 'gpt-4o-mini',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await generate(makeContext(twoStepConversation()));

      expect(proxy.requests).toHaveLength(1);
      expect(proxy.requests[0]?.headers['authorization']).toBe(`Bearer ${PLACEHOLDER_TOKEN}`);
    } finally {
      proxy.stop();
    }
  });

  it('issues only POST /chat/completions across a multi-step run', async () => {
    const proxy = createRecordingProxy(openAIResponseBody);
    try {
      const generate = createOpenAIProvider({
        model: 'gpt-4o-mini',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await runTwoStepLoop(generate);

      const endpoints = new Set(
        proxy.requests.map((request) => `${request.method} ${request.path}`),
      );
      expect(endpoints).toEqual(new Set(['POST /chat/completions']));
      expect(proxy.requests).toHaveLength(2);
    } finally {
      proxy.stop();
    }
  });

  it('the streaming variant issues only POST /chat/completions as well', async () => {
    const sseBody = [
      `data: ${JSON.stringify({ id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', choices: [{ index: 0, delta: { role: 'assistant', content: 'Sunny.' }, finish_reason: null }] })}`,
      '',
      `data: ${JSON.stringify({ id: 'chatcmpl_stream', object: 'chat.completion.chunk', created: 0, model: 'gpt-4o-mini', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const proxy = createRecordingSseProxy(sseBody);
    try {
      const generate = createOpenAIProviderStream({
        model: 'gpt-4o-mini',
        apiKey: PLACEHOLDER_TOKEN,
        baseURL: proxy.baseURL,
      });
      await runTwoStepStreamingLoop(generate);

      const endpoints = new Set(
        proxy.requests.map((request) => `${request.method} ${request.path}`),
      );
      expect(endpoints).toEqual(new Set(['POST /chat/completions']));
      expect(proxy.requests).toHaveLength(2);
    } finally {
      proxy.stop();
    }
  });
});

import { parseAnthropicToolCalls } from 'armorer';
import { toAnthropicMessages } from 'conversationalist';

import {
  classifyProviderError,
  concatenateTextParts,
  createCacheAwareAssembly,
  extractSamplingParameterFields,
  isProviderContractError,
  ProviderError,
  resolveAnthropicEffort,
  resolveAnthropicModel,
  resolveCommonParameters,
  withBackendDescriptors,
  withInputLineage,
  type GenerateContext,
  type GenerateFunction,
  type GenerateResponse,
  type SamplingParameterField,
} from '@lostgradient/operative/provider-kit';
import { anthropicPartsFromBlocks } from './anthropic-blocks.ts';
import { createAnthropicSdkClient, isAnthropicClient } from './anthropic-sdk.ts';
import {
  anthropicDescriptorsFor,
  assertDisabledThinkingSupported,
  assertManualThinkingSupported,
  assertSamplingParametersSupported,
  assertThinkingBudgetBelowMaximum,
  assertThinkingBudgetMeetsMinimum,
  assertThinkingParametersCompatible,
  assertToolChoiceSupported,
  buildAnthropicMessageRequest,
  buildAnthropicUsage,
  resolveAnthropicStepEffort,
} from './anthropic-shared.ts';
import type {
  AnthropicClient,
  AnthropicMessageResponse,
  AnthropicProviderOptions,
} from './anthropic-types.ts';

export {
  createAnthropicTokenCounter,
  type AnthropicTokenCounterOptions,
  type AnthropicTokenCountingOperations,
} from './anthropic-token-counter.ts';

/**
 * Creates a GenerateFunction backed by the Anthropic Messages API.
 *
 * When no `client` is provided, lazily loads `@anthropic-ai/sdk` in Bun or Node.js
 * and constructs one using `apiKey` or the `ANTHROPIC_API_KEY` env var.
 *
 * Note: "Provider" here is distinct from the Vercel AI SDK's concept of
 * "provider". This factory returns a `GenerateFunction` — a plain async
 * function that produces a `GenerateResponse` — not an SDK provider object.
 */
export function createAnthropicProvider(options: AnthropicProviderOptions): GenerateFunction {
  const { maximumTokens = 4096 } = options;
  const resolvedModel = resolveAnthropicModel(options.model);
  const resolvedEffort = options.effort
    ? resolveAnthropicEffort(options.effort, resolvedModel)
    : undefined;
  const common = resolveCommonParameters(options);
  assertSamplingParametersSupported(resolvedModel, common);
  assertDisabledThinkingSupported(resolvedModel, options.thinking, resolvedEffort);
  assertManualThinkingSupported(resolvedModel, options.thinking);
  assertToolChoiceSupported(resolvedModel, options.toolChoice);
  assertThinkingBudgetMeetsMinimum(options.thinking);
  assertThinkingParametersCompatible(options.thinking, options.toolChoice, common);
  let clientPromise: Promise<AnthropicClient> | undefined;
  const cacheAwareAssembly =
    options.assembler && options.contextBudget
      ? createCacheAwareAssembly(
          options.assembler,
          options.contextBudget,
          options.pinnedMessages,
          anthropicDescriptorsFor(resolvedModel),
        )
      : undefined;

  function getClient(): Promise<AnthropicClient> {
    if (options.client) return Promise.resolve(options.client);
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() => {
        const clientOptions: Record<string, unknown> = { apiKey: options.apiKey };
        if (options.baseURL) clientOptions['baseURL'] = options.baseURL;
        return createAnthropicSdkClient<AnthropicClient>(clientOptions, isAnthropicClient);
      });
    }
    return clientPromise;
  }

  const generate: GenerateFunction = async (
    context: GenerateContext,
  ): Promise<GenerateResponse> => {
    const effectiveMaximumTokens = context.maximumTokens ?? maximumTokens;
    assertThinkingBudgetBelowMaximum(options.thinking, effectiveMaximumTokens);
    // The step's steered effort, read per call (COR-1935), not the construction-time one.
    const stepEffort = resolveAnthropicStepEffort(
      context.steering?.effort,
      resolvedEffort,
      resolvedModel,
      options.thinking,
    );
    const client = await getClient();
    const conversationForRequest = cacheAwareAssembly
      ? cacheAwareAssembly(context)
      : context.conversation.current;
    const { system, messages, lineage } = toAnthropicMessages(conversationForRequest, {
      ...(options.extendedCacheTtl ? { extendedCacheTtl: true } : {}),
      sources: context.resolvedSources,
    });
    const tools = await context.toolbox.toAnthropicTools();
    const params = buildAnthropicMessageRequest({
      model: resolvedModel,
      messages,
      maxTokens: effectiveMaximumTokens,
      system,
      effort: stepEffort,
      thinking: options.thinking,
      metadata: options.requestMetadata,
      tools,
      toolChoice: options.toolChoice,
      common,
    });

    const requestOptions = context.signal ? { signal: context.signal } : undefined;

    try {
      const response = await client.messages.create(params, requestOptions);

      return withInputLineage(
        createAnthropicResponse(response, resolvedModel, stepEffort),
        lineage,
      );
    } catch (error) {
      // A response the adapter has no mapping for is the model's output, not an API failure.
      if (isProviderContractError(error)) throw error;
      throw (
        samplingParameterRejection(error, resolvedModel) ??
        new ProviderError({ provider: 'anthropic', cause: error })
      );
    }
  };

  return withBackendDescriptors(generate, anthropicDescriptorsFor(resolvedModel));
}

export { createAnthropicProviderStream } from './anthropic-stream.ts';

const SAMPLING_PARAMETER_DESCRIPTIONS: Record<SamplingParameterField, string> = {
  temperature: '`temperature`',
  top_p: '`top_p` (option `topP`)',
  top_k: '`top_k`',
};

/**
 * Turns Anthropic's 400 for a sampling parameter the resolved model no longer
 * accepts into an error naming the rejected fields, the model, and the remedy.
 * Returns `undefined` for any other failure, which keeps its plain wrapping.
 *
 * Recognized after the response for any model `shared/sampling.ts` does not
 * list: a model list goes stale with every release, so only the models the
 * documentation settles are refused up front (`assertSamplingParametersSupported`). The construction-time thinking
 * guard (`assertThinkingParametersCompatible`) throws before any request is
 * sent, so the two never fire for the same request.
 */
function samplingParameterRejection(
  error: unknown,
  resolvedModel: string,
): ProviderError | undefined {
  if (classifyProviderError(error) !== 'sampling-parameter-unsupported') return undefined;

  const fields = extractSamplingParameterFields(error);
  const described = fields.map((field) => SAMPLING_PARAMETER_DESCRIPTIONS[field]).join(', ');
  const remedy = fields.length === 1 ? 'drop it' : 'drop them';

  return new ProviderError({
    provider: 'anthropic',
    cause: error,
    message:
      `[provider:anthropic] Model ${resolvedModel} rejected ${described}; ${remedy} from the ` +
      `provider options. Provider message: ${providerMessageOf(error)}`,
  });
}

function providerMessageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (
    error &&
    typeof error === 'object' &&
    'message' in error &&
    typeof error.message === 'string'
  ) {
    return error.message;
  }
  return 'Unknown error';
}

function createAnthropicResponse(
  response: AnthropicMessageResponse,
  model: string,
  effort: string | undefined,
): GenerateResponse {
  const usage = response.usage ? buildAnthropicUsage(response.usage) : undefined;
  // Every block is a part, a tool call or an error: nothing the model returned vanishes.
  const parts = anthropicPartsFromBlocks(response.content, usage);
  return {
    content: concatenateTextParts(parts),
    parts,
    toolCalls: parseAnthropicToolCalls(response.content),
    usage,
    metadata: { effectiveModel: model, effectiveEffort: effort ?? 'none' },
  };
}

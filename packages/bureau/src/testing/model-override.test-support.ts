/**
 * Shared fixtures for the tests that switch a session's model (COR-1559): a catalog in which two
 * providers share one model name, and a generate function that records the model each step was
 * told to use and can hold its first step open while a test steers.
 */
import {
  type BackendDescriptor,
  createModelCatalog,
  type GenerateFunction,
} from '@lostgradient/operative';
import { createTool } from 'armorer';
import { z } from 'zod';

import type { ModelsOptions } from '../models/create-models.ts';

/** A catalog row, named the way a model override names it. */
export interface ModelChoice {
  readonly provider: 'anthropic' | 'openai' | 'gemini';
  readonly model: string;
}

export const OPUS_5_5: ModelChoice = { provider: 'anthropic', model: 'claude-opus-5-5' };
export const OPUS_5: ModelChoice = { provider: 'anthropic', model: 'claude-opus-5' };
export const GPT_4_1: ModelChoice = { provider: 'openai', model: 'gpt-4.1' };
/** The row `twinModels` adds: OpenAI serving a model named like Anthropic's. */
export const TWIN_OF_OPUS_5_5: ModelChoice = { provider: 'openai', model: 'claude-opus-5-5' };

/** The `models` option for a Bureau whose catalog is exactly `descriptors`. */
export function modelsOf(descriptors: readonly BackendDescriptor[]): ModelsOptions {
  return { catalog: descriptors };
}

/**
 * The default catalog plus one row in which OpenAI serves a model named like an Anthropic one, so
 * two providers share the model name `claude-opus-5-5`.
 */
export function twinModels(): ModelsOptions {
  const rows = createModelCatalog().descriptors;
  const original = rows.find(
    (row) => row.provider === OPUS_5_5.provider && row.model === OPUS_5_5.model,
  );
  if (original === undefined) throw new Error('The default catalog has no claude-opus-5-5 row.');
  return modelsOf([...rows, { ...original, provider: 'openai' }]);
}

/** What one step was told to use. */
export interface StepObservation {
  readonly model: string | undefined;
  readonly provider: string | undefined;
  /** The effort the step's steering named (COR-1935); absent when it named none. */
  readonly effort?: string | undefined;
}

export const noopTool = createTool({
  name: 'noop',
  description: 'Does nothing',
  input: z.object({}),
  execute: async () => 'ok',
});

/**
 * A generate function that takes two steps per run: a call to `noop`, then a final answer. It
 * records what each step's steering said and holds the very first step until `releaseFirstStep()`,
 * so a test can steer while a run is in the middle of one.
 */
export function createSteppedGenerate() {
  const observed: StepObservation[] = [];
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const generate: GenerateFunction = async (context) => {
    const first = observed.length === 0;
    observed.push({
      model: context.steering?.model,
      provider: context.steering?.modelProvider,
      effort: context.steering?.effort,
    });
    if (first) {
      entered.resolve();
      await release.promise;
    }
    const history = context.conversation.current;
    const last = history.messages[history.ids.at(-1) ?? ''];
    if (last?.toolResult !== undefined) return { content: 'done', toolCalls: [] };
    return {
      content: '',
      toolCalls: [{ id: `call-${observed.length}`, name: 'noop', arguments: {} }],
    };
  };
  return {
    generate,
    observed,
    /** Resolves once the first step is running. */
    firstStepEntered: entered.promise,
    releaseFirstStep: () => release.resolve(),
  };
}

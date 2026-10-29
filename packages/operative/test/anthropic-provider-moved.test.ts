/**
 * The Anthropic provider lives in `@lostgradient/operative-anthropic`. Operative's root, its
 * provider-authoring and provider-testing entry points, and the barrels under `src/providers/` name
 * none of what moved, so a host that wants Anthropic has to name the package.
 */
import * as root from '@lostgradient/operative';
import * as providerKit from '@lostgradient/operative/provider-kit';
import * as providerTesting from '@lostgradient/operative/provider-testing';
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';

/** Every runtime export of `@lostgradient/operative-anthropic` and its `./testing` entry point. */
const MOVED_ANTHROPIC_EXPORTS = [
  'ANTHROPIC_CONTROL_EVENT_TYPES',
  'ANTHROPIC_DISABLED_THINKING',
  'ANTHROPIC_FORCED_TOOL_CHOICE_REJECTED',
  'ANTHROPIC_MANUAL_THINKING',
  'EFFORTS_THAT_FORBID_DISABLED_THINKING',
  'anthropicDescriptorsFor',
  'anthropicDisabledThinkingRule',
  'anthropicMixedResponse',
  'anthropicNoUsageResponse',
  'anthropicOpeningState',
  'anthropicPartFromBlock',
  'anthropicPartsFromBlocks',
  'anthropicProvider',
  'anthropicRejectsManualThinking',
  'anthropicStreamEmptyEvents',
  'anthropicStreamMixedEvents',
  'anthropicStreamMultiToolEvents',
  'anthropicStreamTextEvents',
  'anthropicStreamToolUseEvents',
  'anthropicTextResponse',
  'anthropicToolUseResponse',
  'assertDisabledThinkingSupported',
  'assertManualThinkingSupported',
  'assertSamplingParametersSupported',
  'assertThinkingBudgetBelowMaximum',
  'assertThinkingBudgetMeetsMinimum',
  'assertThinkingParametersCompatible',
  'assertToolChoiceSupported',
  'buildAnthropicMessageRequest',
  'buildAnthropicUsage',
  'createAnthropicBatchClient',
  'createAnthropicProvider',
  'createAnthropicProviderStream',
  'createAnthropicSdkClient',
  'createAnthropicTokenCounter',
  'createMockAnthropicClient',
  'createMockAnthropicStreamingClient',
  'isAnthropicClient',
  'isAnthropicPartBlock',
  'isAnthropicStreamingClient',
  'isAnthropicTokenCountingClient',
  'normalizeAnthropicStream',
  'toAnthropicToolChoice',
] as const;

const entryPoints = { root, providerKit, providerTesting };

/** The barrels under `src/providers/`, which re-export provider files by path. */
const BARRELS = [
  'src/providers/index.ts',
  'src/providers/batches/index.ts',
  'src/providers/streaming/index.ts',
  'src/providers/structured-output/index.ts',
  'src/providers/test/index.ts',
] as const;

describe('the Anthropic provider has left Operative', () => {
  for (const [entryPoint, exports] of Object.entries(entryPoints)) {
    it(`${entryPoint} exports none of the symbols that moved to @lostgradient/operative-anthropic`, () => {
      const stillExported = MOVED_ANTHROPIC_EXPORTS.filter((name) => Object.hasOwn(exports, name));
      expect(stillExported).toEqual([]);
    });
  }

  for (const barrel of BARRELS) {
    it(`${barrel} names none of the symbols that moved`, () => {
      const source = readFileSync(new URL(`../${barrel}`, import.meta.url), 'utf8');
      const stillNamed = MOVED_ANTHROPIC_EXPORTS.filter((name) =>
        new RegExp(`\\b${name}\\b`).test(source),
      );
      expect(stillNamed).toEqual([]);
    });
  }
});

/**
 * The providers the three workspace plugins contribute, as the host holds them: their definitions,
 * Operative's catalog rows and the secret each plugin declares. For tests of the provider modules,
 * which take the contributed providers instead of loading plugins.
 */
import type { BackendDescriptor } from '@lostgradient/operative';
import { anthropicProvider, anthropicRows } from '@lostgradient/operative-anthropic';
import { geminiProvider, geminiRows } from '@lostgradient/operative-gemini';
import { openaiProvider, openAIRows } from '@lostgradient/operative-openai';

import type { ContributedProvider } from './providers.ts';

const DEFINITIONS = {
  anthropic: anthropicProvider,
  openai: openaiProvider,
  gemini: geminiProvider,
};

/** The rows of the three vendor packages, which Operative no longer holds (COR-2151). */
export function vendorRows(): readonly BackendDescriptor[] {
  return [...anthropicRows(), ...openAIRows(), ...geminiRows()];
}

/** The named providers' contributions; every provider of the workspace's three plugins by default. */
export function contributedFixtures(
  names: readonly ('anthropic' | 'openai' | 'gemini')[] = ['anthropic', 'openai', 'gemini'],
  rowsOf: readonly BackendDescriptor[] = vendorRows(),
): readonly ContributedProvider[] {
  return names.map((name) => ({
    plugin: name,
    name,
    definition: DEFINITIONS[name],
    configuration: {},
    rows: rowsOf.filter((row) => row.provider === name),
    secretKey: `${name}-api-key`,
  }));
}

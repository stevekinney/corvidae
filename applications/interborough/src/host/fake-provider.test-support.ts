/**
 * A model provider for tests that need a model in the host's catalog without calling one. The home
 * gets a `configuration.json` naming `anthropic` with the `sonnet` model, and a fixture API key in
 * its secrets; the provider path runs against a fake client that answers every request with a fixed
 * reply. No real provider key is ever used.
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate, type ProviderConfiguration } from '@lostgradient/bureau';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HostOptions } from './host.ts';

/** The fixture secret written for the provider. It is not a credential for anything. */
export const FIXTURE_PROVIDER_KEY = 'fixture-anthropic-key-5e2b';

/**
 * Writes the provider configuration and its secret into a home directory that has neither. `models`
 * is the provider's allowlist, each entry a model or an alias, so a test chooses how many models
 * the catalog offers.
 */
export async function writeProviderHome(
  home: string,
  models: readonly string[] = ['sonnet'],
): Promise<void> {
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ providers: { anthropic: { models } } }),
  );
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    bungalow.writeSecret('anthropic-api-key', FIXTURE_PROVIDER_KEY);
  } finally {
    bungalow.close();
  }
}

/** The provider path whose client answers every request with `reply`, and the requests it saw. */
export function fakeProvider(reply: string) {
  const handed: ProviderConfiguration[] = [];
  const client = {
    messages: {
      create: async () => ({
        id: 'message-1',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-5',
        content: [{ type: 'text', text: reply }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 5 },
      }),
    },
  };
  const resolver: NonNullable<HostOptions['resolveProviderGenerate']> = (
    definitions,
    provider,
    streamEventTarget,
    streaming,
  ) => {
    handed.push(provider);
    return resolveProviderGenerate(
      definitions,
      Object.assign({}, provider, { client }),
      streamEventTarget,
      streaming,
    );
  };
  return { handed, resolver };
}

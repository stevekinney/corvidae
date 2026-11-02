/**
 * A model provider that needs no network and no real key: for tests that need a model in the host's
 * catalog without calling one, and for the showcase development host (`showcase.ts`). The home
 * gets a `configuration.json` naming `anthropic` with the `sonnet` model, and a fixture API key in
 * its secrets; the provider path runs against a fake client that answers every request with a fixed
 * reply. No real provider key is ever used or read.
 *
 * @module stub-provider
 */
import { openBungalow } from '@lostgradient/bungalow';
import { resolveProviderGenerate, type ProviderConfiguration } from '@lostgradient/bureau';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HostOptions } from './host.ts';

/** The fixture secret written for the provider. It is not a credential for anything. */
export const FIXTURE_PROVIDER_KEY = 'fixture-anthropic-key-5e2b';

/**
 * Writes the provider configuration and its secret into a home directory. It replaces the home's
 * `configuration.json`, so a caller that also turns plugins on does that afterwards. `models`
 * is the provider's allowlist, each entry a model or an alias, so a test chooses how many models
 * the catalog offers.
 */
export async function writeProviderHome(
  home: string,
  models: readonly string[] = ['sonnet'],
): Promise<void> {
  await writeFile(
    join(home, 'configuration.json'),
    JSON.stringify({ plugins: { anthropic: { configuration: { models } } } }),
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

/**
 * The words that make the stub's model call fail when a message carries them, so a chat whose run
 * failed can be made on purpose (the showcase seed, `fixtures/showcase-seed.ts`). They are plain
 * words a person could type, because the message that carries them is shown in the chat. They are
 * matched anywhere in the request the client is sent, so they can sit in any message of the thread.
 */
export const STUB_PROVIDER_FAILURE_MARKER = 'simulate a provider failure';

/** The provider path whose client answers every request with `reply`, and the requests it saw. */
export function fakeProvider(reply: string) {
  const handed: ProviderConfiguration[] = [];
  const client = {
    messages: {
      create: async (request: unknown) => {
        if (JSON.stringify(request).includes(STUB_PROVIDER_FAILURE_MARKER)) {
          throw new Error('The model provider is overloaded. Try again in a few minutes.');
        }
        return {
          id: 'message-1',
          type: 'message',
          role: 'assistant',
          model: 'claude-sonnet-5',
          content: [{ type: 'text', text: reply }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 3, output_tokens: 5 },
        };
      },
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

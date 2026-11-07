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
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { HostOptions } from './host.ts';

/** The fixture secret written for the provider. It is not a credential for anything. */
export const FIXTURE_PROVIDER_KEY = 'fixture-anthropic-key-5e2b';

/** Whether `value` is a plain object, so its keys can be read. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The JSON object in `path`, or an empty one when there is no such file. */
async function readConfigurationDocument(path: string): Promise<Record<string, unknown>> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return {};
    throw error;
  }
  const document: unknown = JSON.parse(text);
  if (!isRecord(document)) throw new Error(`${path} does not hold a JSON object.`);
  return document;
}

/** `value` when it is a plain object, else an empty one. */
function asRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

/**
 * Writes the provider configuration and its secret into a home directory. It sets the Anthropic
 * plugin's model allowlist in the home's `configuration.json` and keeps every other key the file
 * holds, plugins another caller turned on included, so it may run before or after
 * `enableDemoPlugin` (`demo-plugin-home.ts`). `models` is the provider's allowlist, each entry a
 * model or an alias, so a test chooses how many models the catalog offers.
 */
export async function writeProviderHome(
  home: string,
  models: readonly string[] = ['sonnet'],
): Promise<void> {
  const bungalow = await openBungalow({
    name: 'interborough',
    environment: { INTERBOROUGH_HOME: home },
  });
  try {
    const path = join(home, 'configuration.json');
    const document = await readConfigurationDocument(path);
    const plugins = asRecord(document['plugins']);
    const anthropic = asRecord(plugins['anthropic']);
    await writeFile(
      path,
      JSON.stringify({
        ...document,
        plugins: {
          ...plugins,
          anthropic: {
            ...anthropic,
            configuration: { ...asRecord(anthropic['configuration']), models },
          },
        },
      }),
    );
    await bungalow.deploymentSecrets.write('anthropic-api-key', FIXTURE_PROVIDER_KEY);
  } finally {
    bungalow.close();
  }
}

/**
 * The words that make the stub's model call fail when a message carries them, so a chat whose run
 * failed can be made on purpose. They are plain
 * words a person could type, because the message that carries them is shown in the chat. They are
 * matched anywhere in the request the client is sent, so they can sit in any message of the thread.
 */
export const STUB_PROVIDER_FAILURE_MARKER = 'simulate a provider failure';

/**
 * The words that make the stub provider refuse an API key with a 401, as a provider does for a key
 * it does not know, so the dialogs that test a key can be driven to their failure. A key carrying
 * them is refused whatever else it says; every other key is accepted.
 */
export const STUB_PROVIDER_REJECTED_KEY_MARKER = 'rejected-key';

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
    // The same reply in the shapes the other two providers' clients answer in, so a key tested
    // against OpenAI or Gemini reaches a client too.
    chat: {
      completions: {
        create: async () => ({
          choices: [{ message: { content: reply }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
        }),
      },
    },
    models: {
      generateContent: async () => ({
        candidates: [{ content: { parts: [{ text: reply }] } }],
        usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 5, totalTokenCount: 8 },
      }),
    },
  };
  const refuse = async (): Promise<never> => {
    throw Object.assign(new Error('invalid x-api-key'), { status: 401 });
  };
  const refusingClient = {
    messages: { create: refuse },
    chat: { completions: { create: refuse } },
    models: { generateContent: refuse },
  };
  const resolver: NonNullable<HostOptions['resolveProviderGenerate']> = (
    definitions,
    provider,
    streamEventTarget,
    streaming,
  ) => {
    handed.push(provider);
    const refused = String(Reflect.get(provider, 'apiKey')).includes(
      STUB_PROVIDER_REJECTED_KEY_MARKER,
    );
    return resolveProviderGenerate(
      definitions,
      Object.assign({}, provider, { client: refused ? refusingClient : client }),
      streamEventTarget,
      streaming,
    );
  };
  return { handed, resolver };
}

/**
 * The sample world's Anthropic catalog for the specifications that look at a connected provider on
 * the main host, whose own model list is longer and differs (`stub-provider.ts`): Opus 5.5, Sonnet
 * 5.5 and Haiku 5.5, as the boards draw them.
 */
import type { Page } from '@playwright/test';

/** One model of the sample world's Anthropic catalog, as the host's providers route lists it. */
function sampleModel(model: string, extra: Record<string, unknown>) {
  return {
    provider: 'anthropic',
    model,
    aliases: [],
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 128_000,
    streaming: true,
    tools: true,
    structuredOutput: true,
    images: true,
    off: false,
    ...extra,
  };
}

/** The models of the sample world's catalog: Opus 5.5 and Sonnet 5.5 take images, Haiku 5.5 does not. */
export function sampleCatalogModels() {
  return [
    sampleModel('claude-opus-5-5', {}),
    sampleModel('claude-sonnet-5-5', {}),
    sampleModel('claude-haiku-5-5', { images: false, contextWindowTokens: 200_000 }),
  ];
}

/**
 * Answers the host's providers as if a local Ollama, which declares no secret, were loaded: its
 * provider is connected with no key saved and offers one model, beside the sample world's three.
 */
export async function withKeylessProvider(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as { providers: { name: string }[] };
    return route.fulfill({
      response,
      json: {
        ...body,
        providers: [
          ...body.providers,
          { name: 'ollama', configured: false, hasKey: false, connected: true },
        ],
        models: [
          ...sampleCatalogModels(),
          sampleModel('llama-3-2', {
            provider: 'ollama',
            contextWindowTokens: 128_000,
            maxOutputTokens: 8_000,
            structuredOutput: false,
            images: false,
          }),
        ],
      },
    });
  });
}

/** Answers the host's providers with Anthropic connected and the sample world's three models. */
export async function withSampleCatalog(page: Page): Promise<void> {
  await page.route('**/host/providers', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const response = await route.fetch();
    const body = (await response.json()) as Record<string, unknown>;
    return route.fulfill({ response, json: { ...body, models: sampleCatalogModels() } });
  });
}

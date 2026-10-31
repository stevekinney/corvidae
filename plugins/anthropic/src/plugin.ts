import { definePlugin } from '@lostgradient/interborough-plugin';
import { anthropicProvider } from '@lostgradient/operative-anthropic';
import { z } from 'zod';

/** The Bungalow secret that holds the Anthropic API key. It is the key the host has always used. */
export const ANTHROPIC_API_KEY_SECRET = 'anthropic-api-key';

/**
 * The plugin's configuration, `plugins.anthropic.configuration` in Bungalow's `configuration.json`:
 * an optional allowlist of models, each a model name or an alias of one. The host reads it on every
 * catalog load, so a change to the allowlist applies without a restart.
 */
export const anthropicConfiguration = z
  .object({ models: z.array(z.string().min(1)).min(1).optional() })
  .strict();

/**
 * The Anthropic plugin. It contributes the Anthropic provider and its catalog rows, which Operative
 * ships with the provider. It needs `anthropic-api-key`; without it the plugin is `needs-setup` and
 * the host offers none of its models.
 */
export default definePlugin({
  name: 'anthropic',
  version: '0.1.0',
  description: 'Anthropic Claude models for agents.',
  configuration: anthropicConfiguration,
  secrets: [ANTHROPIC_API_KEY_SECRET],
  setup: () => ({ providers: [anthropicProvider] }),
});

/**
 * COR-2142 — which declared secret holds a provider's API key is named by the provider's
 * `secretKey`, never read from the order of the plugin's declarations.
 */
import {
  definePlugin,
  type PluginProvider,
  type PluginSecretDeclaration,
} from '@lostgradient/interborough-plugin';
import { describe, expect, it } from 'bun:test';

import { composePlugins } from './compose-plugins';
import type { PluginModelContributions, PluginProblem } from './plugin-types';

const provider = (secretKey?: string): PluginProvider => ({
  name: 'lender',
  generate: () => async () => ({ content: '', toolCalls: [] }),
  stream: () => async () => ({}) as never,
  rows: [],
  ...(secretKey === undefined ? {} : { secretKey }),
});

async function compose(
  secrets: readonly PluginSecretDeclaration[] | undefined,
  secretKey?: string,
): Promise<{
  readonly status: string | undefined;
  readonly problems: readonly PluginProblem[];
  readonly received: PluginModelContributions | undefined;
}> {
  let received: PluginModelContributions | undefined;
  const descriptor = definePlugin({
    name: 'lender',
    version: '1.0.0',
    description: 'Contributes a model provider.',
    ...(secrets === undefined ? {} : { secrets }),
    setup: () => ({ providers: [provider(secretKey)] }),
  });
  const composed = await composePlugins({
    plugins: [{ descriptor, source: 'package', location: '@example/lender' }],
    models: {
      catalog: (contributions) => {
        received = contributions;
        return [];
      },
    },
  });
  const [record] = composed.records;
  return { status: record?.status, problems: record?.problems ?? [], received };
}

describe('a provider’s secretKey', () => {
  it('is the key when it names one of several declared secrets', async () => {
    const { status, received } = await compose(['first-key', 'second-key'], 'second-key');
    expect(status).not.toBe('skipped');
    expect(received?.providers[0]?.secretKey).toBe('second-key');
  });

  it('names a generated secret by its key', async () => {
    const { received } = await compose(['first-key', { key: 'seed', generated: true }], 'seed');
    expect(received?.providers[0]?.secretKey).toBe('seed');
  });

  it('is refused with provider-secret-unknown when the plugin does not declare it', async () => {
    const { status, problems, received } = await compose(['first-key'], 'other-key');
    expect(status).toBe('skipped');
    expect(problems).toEqual([
      { code: 'provider-secret-unknown', provider: 'lender', key: 'other-key' },
    ]);
    expect(received?.providers).toEqual([]);
  });

  it('is refused when the plugin declares no secret at all', async () => {
    const { status, problems } = await compose(undefined, 'other-key');
    expect(status).toBe('skipped');
    expect(problems.map(({ code }) => code)).toEqual(['provider-secret-unknown']);
  });
});

describe('a provider with no secretKey', () => {
  it('uses the plugin’s one declared secret', async () => {
    const { received } = await compose(['only-key']);
    expect(received?.providers[0]?.secretKey).toBe('only-key');
  });

  it('uses the one declared secret when it is a generated one', async () => {
    const { received } = await compose([{ key: 'seed', generated: true }]);
    expect(received?.providers[0]?.secretKey).toBe('seed');
  });

  it('is keyless when the plugin declares no secret', async () => {
    const { status, received } = await compose(undefined);
    expect(status).not.toBe('skipped');
    expect(received?.providers).toHaveLength(1);
    expect(received?.providers[0]?.secretKey).toBeUndefined();
  });

  it('is refused with provider-secret-ambiguous when the plugin declares several', async () => {
    const { status, problems, received } = await compose(['first-key', 'second-key']);
    expect(status).toBe('skipped');
    expect(problems).toEqual([
      {
        code: 'provider-secret-ambiguous',
        provider: 'lender',
        secrets: ['first-key', 'second-key'],
      },
    ]);
    expect(received?.providers).toEqual([]);
  });
});

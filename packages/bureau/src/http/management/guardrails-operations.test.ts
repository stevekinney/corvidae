/**
 * COR-2118 — `bureau.guardrails.list` over a real Bureau that loads a plugin and is given host
 * guardrails: every installed guardrail is listed, one row per family, each with a non-empty
 * description, its configuration as JSON Schema when a file can configure it, and its source; the
 * operation is authorized as its sibling read `bureau.plugins.contributions` is.
 */
import { definePlugin } from '@lostgradient/interborough-plugin';
import { afterEach, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createAgentContributions } from '../../agent-contributions.ts';
import { composePlugins } from '../../plugins/compose-plugins.ts';
import { createPluginRegistry } from '../../plugins/plugin-registry.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { OPERATION_MAP } from '../operation-map.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';
import { guardrailsListOperation } from './guardrails-operations.ts';
import { pluginKindsOperation } from './plugin-kinds-operations.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

const detect = async () => ({ triggered: false, category: 'x', confidence: 0 });
const validate = async () => ({ valid: true, category: 'x', confidence: 0 });

const shield = definePlugin({
  name: 'shield',
  version: '1.0.0',
  description: 'Guards things.',
  configuration: z.object({ threshold: z.number().default(0.8) }),
  setup: ({ configuration }) => ({
    guardrails: {
      input: [{ name: 'scan', description: 'Scans the input.', detect }],
      output: [
        {
          guardrail: {
            name: 'grounding',
            description: 'Flags unsupported claims.',
            configuration: z.strictObject({
              threshold: z.number().min(0).max(1).default(configuration.threshold),
            }),
            create: () => ({ name: 'grounding', validate }),
          },
          action: 'warn',
        },
      ],
      tools: [{ name: 'cap', description: 'Caps refunds.', validate }],
      memory: [{ name: 'scan', description: 'Scans what memory keeps.', detect }],
    },
  }),
});

async function open(): Promise<OpenedBureau> {
  const opened = await openBureau({
    bureauOptions: {
      plugins: [{ descriptor: shield, source: 'package', location: '@example/shield' }],
      pluginConfiguration: { shield: { enabled: true, configuration: { threshold: 0.6 } } },
      agentContributions: createAgentContributions([
        {
          plugin: 'house',
          guardrails: { output: [{ name: 'tone', description: 'Keeps it polite.', validate }] },
        },
      ]),
    },
  });
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('bureau.guardrails.list', () => {
  it('is served, described, read-only, and authorized as bureau.plugins.contributions is', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(guardrailsListOperation);
    expect(guardrailsListOperation.destructive).toBe(false);
    expect(guardrailsListOperation.access).toEqual(pluginKindsOperation.access);
    expect(guardrailsListOperation.mcpExposable).toBe(pluginKindsOperation.mcpExposable);
    expect(OPERATION_MAP['bureau.guardrails.list'].workspaceClass).toBe(
      OPERATION_MAP['bureau.plugins.contributions'].workspaceClass,
    );
    expect(guardrailsListOperation.description?.length ?? 0).toBeGreaterThan(40);
  });

  it('lists a memory guardrail only when the host composes memory, which installs it', async () => {
    const entry = { descriptor: shield, source: 'package', location: '@example/shield' } as const;
    const bare = await composePlugins({ plugins: [entry] });
    expect(
      createPluginRegistry(bare.records)
        .plugins.guardrails()
        .map(({ family }) => family),
    ).toEqual(['input', 'output', 'tools']);

    const withMemory = await composePlugins({ plugins: [entry], memory: () => undefined as never });
    expect(
      createPluginRegistry(withMemory.records)
        .plugins.guardrails()
        .filter(({ family }) => family === 'memory'),
    ).toEqual([
      {
        id: 'shield:scan',
        family: 'memory',
        description: 'Scans what memory keeps.',
        configurable: false,
        configuration: null,
        source: 'plugin',
        plugin: 'shield',
      },
    ]);
  });

  it('lists every installed guardrail, the host’s first, each with a description and its source', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.guardrails.list', {}, 'alice-key');
    expect(body.error).toBeUndefined();
    const rows = body.result!['guardrails'] as Array<Record<string, unknown>>;

    expect(rows.map(({ id, family, source, plugin }) => ({ id, family, source, plugin }))).toEqual([
      { id: 'house:tone', family: 'output', source: 'host', plugin: 'house' },
      { id: 'shield:scan', family: 'input', source: 'plugin', plugin: 'shield' },
      { id: 'shield:grounding', family: 'output', source: 'plugin', plugin: 'shield' },
      { id: 'shield:cap', family: 'tools', source: 'plugin', plugin: 'shield' },
    ]);
    for (const row of rows) expect((row['description'] as string).length).toBeGreaterThan(0);
  });

  it('gives a factory’s configuration as JSON Schema with the plugin-wide default, and none to the rest', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.guardrails.list', {}, 'alice-key');
    const rows = body.result!['guardrails'] as Array<Record<string, unknown>>;
    const grounding = rows.find((row) => row['id'] === 'shield:grounding');

    expect(grounding).toMatchObject({
      configurable: true,
      description: 'Flags unsupported claims.',
    });
    expect(grounding?.['configuration']).toMatchObject({
      type: 'object',
      properties: { threshold: { type: 'number', minimum: 0, maximum: 1, default: 0.6 } },
      additionalProperties: false,
    });
    for (const row of rows.filter((each) => each !== grounding)) {
      expect(row).toMatchObject({ configurable: false, configuration: null });
    }
  });

  it('refuses a request with no credential, as its sibling does', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.guardrails.list', {}, 'no-such-key');
    const sibling = await rpc(opened.handler, 'bureau.plugins.contributions', {}, 'no-such-key');
    expect(body.error).toBeDefined();
    expect(body.error?.code).toBe(sibling.error?.code);
  });
});

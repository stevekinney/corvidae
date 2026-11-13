/**
 * COR-2245 (D7) — a contributed activity names its `title` and its `inputSchema`. A plugin whose
 * activity lacks either fails setup with an `activity-field-missing` problem naming the field, the
 * contributed-activity catalog refuses it the same way, and the editor catalog lists the title.
 */
import { definePlugin, type PluginActivity } from '@lostgradient/interborough-plugin';
import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { composePlugins } from './plugins/compose-plugins';
import { createVersionedCatalog } from './versioned-catalog';
import { createWorkflowContributions } from './workflow-contributions';
import { createWorkflowDocumentHost, workflowCatalogOf } from './workflow-host';

const complete = {
  name: 'lookup',
  title: 'Look up an issue',
  inputSchema: z.object({ issue: z.string() }),
  execute: () => 'found',
} satisfies PluginActivity;

/** An activity with `field` left out, or given as `value`, as a plugin written in JavaScript can. */
function without(field: 'title' | 'inputSchema', value?: unknown): PluginActivity {
  const { [field]: _removed, ...rest } = complete;
  return (value === undefined ? rest : { ...rest, [field]: value }) as unknown as PluginActivity;
}

const CASES = [
  { name: 'no title', activity: without('title'), problems: [['lookup', 'title']] },
  { name: 'a blank title', activity: without('title', '  '), problems: [['lookup', 'title']] },
  {
    name: 'no inputSchema',
    activity: without('inputSchema'),
    problems: [['lookup', 'inputSchema']],
  },
  {
    name: 'neither',
    activity: { name: 'lookup', execute: () => 'x' } as unknown as PluginActivity,
    problems: [
      ['lookup', 'title'],
      ['lookup', 'inputSchema'],
    ],
  },
] as const;

describe('a plugin that contributes an activity without a required field', () => {
  for (const { name, activity, problems } of CASES) {
    it(`is skipped with activity-field-missing for ${name}`, async () => {
      const descriptor = definePlugin({
        name: 'lender',
        version: '1.0.0',
        description: 'Contributes an activity.',
        setup: () => ({ activities: [activity] }),
      });
      const composed = await composePlugins({
        plugins: [{ descriptor, source: 'package', location: '@example/lender' }],
      });
      const [record] = composed.records;
      expect(record?.status).toBe('skipped');
      expect(record?.problems).toEqual(
        problems.map(([activityName, field]) => ({
          code: 'activity-field-missing',
          activity: activityName,
          field,
        })),
      );
    });
  }

  it('runs when the activity names both', async () => {
    const descriptor = definePlugin({
      name: 'lender',
      version: '1.0.0',
      description: 'Contributes an activity.',
      setup: () => ({ activities: [complete] }),
    });
    const composed = await composePlugins({
      plugins: [{ descriptor, source: 'package', location: '@example/lender' }],
    });
    expect(composed.records[0]?.status).toBe('running');
  });
});

describe('the contributed-activity catalog', () => {
  for (const { name, activity } of CASES) {
    it(`refuses ${name}, naming the field`, () => {
      const catalog = createVersionedCatalog();
      catalog.register({
        kind: 'activity',
        name: 'lender:lookup',
        version: '1.0.0',
        value: activity,
        source: { name: 'lender', version: '1.0.0' },
      });
      const field = name === 'no inputSchema' ? 'inputSchema' : 'title';
      expect(() => createWorkflowContributions(catalog)).toThrow(
        new RegExp(`lender:lookup.*no ${field}`),
      );
    });
  }
});

describe('the workflow editor catalog', () => {
  it('lists the title of each contributed activity', () => {
    const catalog = createVersionedCatalog();
    catalog.register({
      kind: 'activity',
      name: 'lender:lookup',
      version: '1.0.0',
      value: complete,
      source: { name: 'lender', version: '1.0.0' },
    });
    const contributions = createWorkflowContributions(catalog);
    const host = createWorkflowDocumentHost({
      runAgentStep: () => Promise.reject(new Error('unreachable')),
      contributions,
    });
    const activities = workflowCatalogOf(host, contributions).activities;
    expect(activities.find((entry) => entry.id === 'lender:lookup')?.title).toBe(
      'Look up an issue',
    );
    expect(activities.find((entry) => entry.id === 'agent')?.title).toBe('Run an agent');
  });
});

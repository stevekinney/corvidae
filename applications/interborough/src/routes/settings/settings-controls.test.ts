import { SETTING_APPLY, SETTING_KEYS, settingsSchema } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import type { SchemaNode } from '../../lib/bureau-settings.ts';
import { controlFor, groupOf, groupsOf, type Control } from './settings-controls.ts';

/** The schema the Bureau publishes, built as `bureau.settings.schema()` builds it. */
const published = z.toJSONSchema(settingsSchema, { io: 'input' }) as {
  properties: Record<string, SchemaNode>;
};

describe('the controls', () => {
  test('are chosen by the Bureau’s own schema, one for every key', () => {
    expect(Object.keys(published.properties)).toEqual([...SETTING_KEYS]);
    for (const key of SETTING_KEYS) {
      const node = published.properties[key];
      expect(node, key).toBeDefined();
      const control = controlFor(node as SchemaNode);
      expect([
        'toggle',
        'select',
        'text',
        'number',
        'fields',
        'literal-or-fields',
        'switch-json',
        'json',
      ]).toContain(control.kind);
    }
  });

  test('read each key’s shape', () => {
    const kinds = Object.fromEntries(
      SETTING_KEYS.map((key) => [key, controlFor(published.properties[key] as SchemaNode).kind]),
    );
    expect(kinds).toEqual({
      'tools.humanInput': 'switch-json',
      'tools.wakeup': 'toggle',
      'tools.decide': 'toggle',
      modelPolicy: 'json',
      'decisions.fallbackModel': 'text',
      'decisions.maximumPerTask': 'number',
      'retention.audit': 'literal-or-fields',
      'retention.events': 'literal-or-fields',
      'retention.tasks': 'literal-or-fields',
      'retention.receipts': 'fields',
      'retention.checkpoints': 'literal-or-fields',
      'sessionInput.sessionBacklogLimit': 'number',
      'sessionInput.principalBacklogLimit': 'number',
      'children.delegation.defaultTimeToLiveMilliseconds': 'number',
      'engine.retention': 'json',
      'engine.retentionSweepInterval': 'number',
      'engine.retentionSweepBatchSize': 'number',
      'engine.history': 'json',
      'engine.payloadSize': 'json',
      'engine.checkpointSizeWarningThreshold': 'number',
      'engine.schedulerPollIntervalMs': 'number',
      'engine.checkpointHistory': 'number',
      'engine.maxNestingDepth': 'number',
      'engine.workflowClaimTtl': 'number',
      'engine.workflowClaimRenewInterval': 'number',
      durable: 'toggle',
      maintenance: 'select',
      'durableOwnership.ownership': 'select',
      workflowVersion: 'text',
      'a2a.push.enabled': 'toggle',
      'a2a.push.sweepIntervalMs': 'number',
    });
  });

  test('give a retention union its literals and its numbers', () => {
    const audit = controlFor(published.properties['retention.audit'] as SchemaNode);
    expect(audit).toMatchObject({ kind: 'literal-or-fields', literals: ['forever'] });
    const checkpoints = controlFor(published.properties['retention.checkpoints'] as SchemaNode);
    expect(checkpoints).toMatchObject({ kind: 'literal-or-fields', literals: ['keep-all'] });
    expect(
      (checkpoints as Extract<Control, { kind: 'literal-or-fields' }>).fields.map((f) => [
        f.name,
        f.required,
      ]),
    ).toEqual([
      ['keepLast', true],
      ['timeoutMilliseconds', false],
    ]);
  });

  test('fall to the JSON editor for a shape nothing more specific reads, and never to an unsupported one', () => {
    expect(controlFor({ type: 'array' })).toEqual({ kind: 'json' });
    expect(controlFor({})).toEqual({ kind: 'json' });
    expect(controlFor({ anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({
      kind: 'json',
    });
  });
});

describe('the groups', () => {
  test('are the first segment of a key, with the keys that fix how the deployment is built under Durability', () => {
    expect(groupOf('tools.wakeup')).toBe('tools');
    expect(groupOf('modelPolicy')).toBe('modelPolicy');
    expect(groupOf('engine.history')).toBe('engine');
    for (const key of ['durable', 'maintenance', 'durableOwnership.ownership', 'workflowVersion']) {
      expect(groupOf(key), key).toBe('durability');
    }
  });

  test('cover every key of the schema, in a fixed order', () => {
    expect(groupsOf(SETTING_KEYS)).toEqual([
      'tools',
      'modelPolicy',
      'decisions',
      'retention',
      'sessionInput',
      'children',
      'engine',
      'durability',
      'a2a',
    ]);
    // A group the page does not know comes after the ones it does, so a new key is not dropped.
    expect(groupsOf(['zeta.key', 'tools.wakeup'])).toEqual(['tools', 'zeta']);
  });

  test('know how every key applies', () => {
    expect(Object.keys(SETTING_APPLY)).toEqual([...SETTING_KEYS]);
  });
});

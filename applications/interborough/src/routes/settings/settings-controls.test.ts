import { SETTING_APPLY, SETTING_KEYS, settingsSchema } from '@lostgradient/bureau';
import { describe, expect, test } from 'bun:test';
import { z } from 'zod';

import type { SchemaNode } from '../../lib/bureau-settings.ts';
import {
  controlFor,
  groupOf,
  groupsOf,
  holdsForm,
  holdsJson,
  inSection,
  MODEL_POLICY_KEY,
} from './settings-controls.ts';

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
      const control = controlFor(key, node as SchemaNode);
      expect([
        'toggle',
        'select',
        'text',
        'number',
        'choice',
        'form',
        'switch-form',
        'switch-json',
        'json',
      ]).toContain(control.kind);
    }
  });

  test('read each key’s shape', () => {
    const kinds = Object.fromEntries(
      SETTING_KEYS.map((key) => [
        key,
        controlFor(key, published.properties[key] as SchemaNode).kind,
      ]),
    );
    expect(kinds).toEqual({
      'tools.humanInput': 'switch-json',
      'tools.wakeup': 'toggle',
      'tools.decide': 'toggle',
      modelPolicy: 'form',
      'decisions.model': 'choice',
      'decisions.fallbackModel': 'choice',
      'decisions.maximumPerTask': 'number',
      'context.summarizerModel': 'choice',
      'retention.audit': 'form',
      'retention.events': 'form',
      'retention.tasks': 'form',
      'retention.receipts': 'form',
      'retention.memory': 'form',
      'memory.embedder': 'text',
      'retention.logs': 'form',
      'retention.notifications': 'form',
      'retention.hookDeliveries': 'form',
      'logs.maximumLinesPerRun': 'number',
      'retention.checkpoints': 'form',
      'sessionInput.sessionBacklogLimit': 'number',
      'sessionInput.principalBacklogLimit': 'number',
      'children.delegation.defaultTimeToLiveMilliseconds': 'number',
      'engine.retention': 'form',
      'engine.retentionSweepInterval': 'number',
      'engine.retentionSweepBatchSize': 'number',
      'engine.history': 'form',
      'engine.payloadSize': 'form',
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

  test('give an object, and a union with one, a form over its node', () => {
    for (const key of [
      'retention.audit',
      'retention.checkpoints',
      'engine.history',
      'modelPolicy',
    ]) {
      const control = controlFor(key, published.properties[key] as SchemaNode);
      expect(control, key).toEqual({ kind: 'form' });
      expect(holdsForm(control)).toBe(true);
    }
  });

  test('give false-or-an-object a switch, and the object’s own control while it is on', () => {
    // The only such setting holds answer schemas, a record no form has a field for: JSON.
    const control = controlFor(
      'tools.humanInput',
      published.properties['tools.humanInput'] as never,
    );
    expect(control).toEqual({ kind: 'switch-json' });
    expect(holdsJson(control)).toBe(true);
    expect(holdsForm(control)).toBe(false);
    // An object with fields of its own is a form while the switch is on.
    const withFields = controlFor('x', {
      anyOf: [{ const: false }, { type: 'object', properties: { count: { type: 'integer' } } }],
    });
    expect(withFields).toEqual({ kind: 'switch-form' });
    expect(holdsForm(withFields)).toBe(true);
  });

  test('give an open object, one that declares no field, the JSON editor and not an empty form', () => {
    expect(controlFor('x', { type: 'object' })).toEqual({ kind: 'json' });
    expect(
      controlFor('x', {
        type: 'object',
        properties: { answers: { type: 'object' } },
      }),
    ).toEqual({ kind: 'json' });
    // A record of strings is a field of a form (rows of keys and values).
    expect(
      controlFor('x', {
        type: 'object',
        properties: { labels: { type: 'object', additionalProperties: { type: 'string' } } },
      }),
    ).toEqual({ kind: 'form' });
  });

  test('give a key that names a model a choice of models, never a typed provider and model', () => {
    for (const key of ['decisions.fallbackModel', 'context.summarizerModel']) {
      expect(controlFor(key, published.properties[key] as SchemaNode)).toEqual({
        kind: 'choice',
        source: 'catalog-rows',
      });
    }
    expect(controlFor('decisions.model', published.properties['decisions.model'] as never)).toEqual(
      { kind: 'choice', source: 'decision-models' },
    );
  });

  test('fall to the JSON editor for a shape nothing more specific reads, and never to an unsupported one', () => {
    const json = controlFor('a', { type: 'array' });
    expect(json).toEqual({ kind: 'json' });
    expect(holdsJson(json)).toBe(true);
    expect(controlFor('a', {})).toEqual({ kind: 'json' });
    expect(controlFor('a', { anyOf: [{ type: 'string' }, { type: 'number' }] })).toEqual({
      kind: 'json',
    });
  });
});

describe('the sections', () => {
  test('keep the model policy out of General and nothing else out of it', () => {
    expect(inSection(MODEL_POLICY_KEY, 'model-policy')).toBe(true);
    expect(inSection(MODEL_POLICY_KEY, 'general')).toBe(false);
    for (const key of SETTING_KEYS.filter((key) => key !== MODEL_POLICY_KEY)) {
      expect(inSection(key, 'general'), key).toBe(true);
      expect(inSection(key, 'model-policy'), key).toBe(false);
    }
  });
});

describe('the groups', () => {
  test('are the first segment of a key, with the keys that fix how the deployment is built under Durability', () => {
    expect(groupOf('tools.wakeup')).toBe('tools');
    expect(groupOf('engine.history')).toBe('engine');
    for (const key of ['durable', 'maintenance', 'durableOwnership.ownership', 'workflowVersion']) {
      expect(groupOf(key), key).toBe('durability');
    }
  });

  test('cover every key of the schema, in a fixed order', () => {
    expect(groupsOf(SETTING_KEYS.filter((key) => key !== MODEL_POLICY_KEY))).toEqual([
      'tools',
      'decisions',
      'context',
      'retention',
      'memory',
      'logs',
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

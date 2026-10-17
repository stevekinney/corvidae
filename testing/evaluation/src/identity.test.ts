import { describe, expect, test } from 'bun:test';

import { sha256Hex } from '@lostgradient/cryptography';

import { parseEvaluatorConfiguration } from './configuration';
import { modelConfigurationInput } from './evaluation.test-support';
import { canonicalJson, evaluatorIdentity } from './identity';

/** Reverses every object's key order, recursively, without changing any value. */
function reverseKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reverseKeys);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .toReversed()
        .map(([key, entry]) => [key, reverseKeys(entry)]),
    );
  }
  return value;
}

/** One valid single-field change per top-level configuration field. */
const FIELD_CHANGES: Record<string, (input: Record<string, unknown>) => void> = {
  name: (input) => (input['name'] = 'capital-cities-v2'),
  revision: (input) => (input['revision'] = 4),
  passThreshold: (input) => (input['passThreshold'] = 0.8),
  criteria: (input) => {
    const criteria = input['criteria'] as Record<string, unknown>[];
    criteria[1] = { ...criteria[1], weight: 2 };
  },
  examples: (input) => (input['examples'] = []),
  referenceMaterial: (input) => {
    (input['referenceMaterial'] as Record<string, unknown>)['version'] = 'style-guide-2026-10';
  },
  judge: (input) => ((input['judge'] as Record<string, unknown>)['effort'] = 'high'),
  promptVersion: (input) => (input['promptVersion'] = 'judge-prompt-4'),
  datasetVersion: (input) => (input['datasetVersion'] = 'capitals-2026-10'),
  environment: (input) => {
    (input['environment'] as Record<string, unknown>)['revision'] = 'harness-8';
  },
  budgets: (input) => {
    const budgets = input['budgets'] as Record<string, Record<string, unknown>>;
    budgets['perGateRun'] = { ...budgets['perGateRun'], costUsd: 6 };
  },
  repetitions: (input) => (input['repetitions'] = 5),
  variancePolicy: (input) => {
    (input['variancePolicy'] as Record<string, unknown>)['version'] = '2';
  },
  resultSchemaVersion: (input) => (input['resultSchemaVersion'] = 2),
  codeRevision: (input) => (input['codeRevision'] = '41257994'),
};

describe('canonicalJson', () => {
  test('sorts object keys at every depth and preserves array order', () => {
    expect(canonicalJson({ b: [{ z: 1, a: 2 }, 3], a: { d: null, c: 'x' } })).toBe(
      '{"a":{"c":"x","d":null},"b":[{"a":2,"z":1},3]}',
    );
  });

  test('omits undefined object members the way JSON does', () => {
    expect(canonicalJson({ a: 1, b: undefined })).toBe(canonicalJson({ a: 1 }));
  });
});

describe('evaluatorIdentity', () => {
  test('names the configuration and revision and digests its canonical serialization', async () => {
    const configuration = parseEvaluatorConfiguration(modelConfigurationInput());
    const identity = await evaluatorIdentity(configuration);
    expect(identity).toEqual({
      name: 'capital-cities',
      revision: 3,
      digest: await sha256Hex(canonicalJson(configuration)),
    });
    expect(identity.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  test('covers every top-level configuration field', () => {
    expect(Object.keys(FIELD_CHANGES).toSorted()).toEqual(
      Object.keys(modelConfigurationInput()).toSorted(),
    );
  });

  test.each(Object.keys(FIELD_CHANGES))('changes digest when %s changes', async (field) => {
    const base = await evaluatorIdentity(parseEvaluatorConfiguration(modelConfigurationInput()));
    const changed = modelConfigurationInput();
    FIELD_CHANGES[field]!(changed);
    const identity = await evaluatorIdentity(parseEvaluatorConfiguration(changed));
    expect(identity.digest).not.toBe(base.digest);
  });

  test('gives structurally equal configurations with different key order the same digest', async () => {
    const input = modelConfigurationInput();
    const reordered = reverseKeys(input);
    expect(Object.keys(reordered as object)).not.toEqual(Object.keys(input));
    const first = await evaluatorIdentity(parseEvaluatorConfiguration(input));
    const second = await evaluatorIdentity(parseEvaluatorConfiguration(reordered));
    expect(second.digest).toBe(first.digest);
  });
});

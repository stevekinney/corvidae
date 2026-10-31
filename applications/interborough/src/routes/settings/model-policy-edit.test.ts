import { describe, expect, test } from 'bun:test';

import {
  committedPolicy,
  fieldOf,
  LOCAL_PROFILE,
  policyOf,
  withField,
} from './model-policy-edit.ts';

describe('the model policy', () => {
  test('is an empty policy at revision zero when the setting has no value', () => {
    expect(policyOf(undefined)).toEqual({ policyRevision: 0 });
    expect(policyOf({ policyRevision: 4, deployment: { deniedModels: ['x'] } })).toEqual({
      policyRevision: 4,
      deployment: { deniedModels: ['x'] },
    });
    expect(policyOf({ deployment: {} })).toEqual({ deployment: {}, policyRevision: 0 });
  });

  test('sets a field of Allowed models and of the caller’s own entry, leaving the other layers alone', () => {
    const start = policyOf({
      policyRevision: 2,
      bureau: { deniedRegions: ['eu'] },
      users: { other: { dataPolicy: 'standard' } },
    });
    const allowed = withField(start, 'allowed-models', 'deniedProviders', ['openai']);
    expect(allowed.deployment).toEqual({ deniedProviders: ['openai'] });
    expect(allowed.bureau).toEqual({ deniedRegions: ['eu'] });
    const yours = withField(allowed, 'your-preferences', 'defaultEffort', 'high');
    expect(yours.users).toEqual({
      other: { dataPolicy: 'standard' },
      [LOCAL_PROFILE]: { defaultEffort: 'high' },
    });
    expect(fieldOf(yours, 'your-preferences', 'defaultEffort')).toBe('high');
    expect(fieldOf(yours, 'allowed-models', 'deniedProviders')).toEqual(['openai']);
    expect(fieldOf(start, 'your-preferences', 'defaultEffort')).toBeUndefined();
  });

  test('keeps the fields of the entry it does not edit', () => {
    const start = policyOf({
      policyRevision: 1,
      users: { [LOCAL_PROFILE]: { exactOverride: { model: 'm' }, fallbackOrder: ['a'] } },
    });
    const next = withField(start, 'your-preferences', 'costPreference', 'lowest-cost');
    expect(next.users?.[LOCAL_PROFILE]).toEqual({
      exactOverride: { model: 'm' },
      fallbackOrder: ['a'],
      costPreference: 'lowest-cost',
    });
  });

  test('removes a field set to nothing or an empty list, and a layer left with no field', () => {
    const start = withField(
      withField(policyOf(undefined), 'allowed-models', 'deniedModels', ['x']),
      'your-preferences',
      'dataPolicy',
      'standard',
    );
    const cleared = withField(
      withField(start, 'allowed-models', 'deniedModels', []),
      'your-preferences',
      'dataPolicy',
      undefined,
    );
    expect(cleared).toEqual({ policyRevision: 0 });
  });

  test('raises the revision by one for a changed policy, and not at all for one put back', () => {
    const stored = policyOf({ policyRevision: 5, deployment: { deniedModels: ['x'] } });
    const changed = committedPolicy(
      stored,
      withField(stored, 'allowed-models', 'deniedModels', ['x', 'y']),
    );
    expect(changed.policyRevision).toBe(6);
    expect(changed.deployment).toEqual({ deniedModels: ['x', 'y'] });
    // Edited again, it is still one past what is stored, not two.
    const again = committedPolicy(
      stored,
      withField(changed, 'allowed-models', 'deniedModels', ['x', 'z']),
    );
    expect(again.policyRevision).toBe(6);
    const back = committedPolicy(
      stored,
      withField(changed, 'allowed-models', 'deniedModels', ['x']),
    );
    expect(back).toBe(stored);
  });
});

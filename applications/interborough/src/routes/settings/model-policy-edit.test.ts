import { describe, expect, test } from 'bun:test';

import {
  changedChoices,
  committedPolicy,
  defaultEffortOf,
  fieldOf,
  isModelAllowed,
  LOCAL_PROFILE,
  policyOf,
  preferenceOf,
  withField,
  withModelAllowed,
  withPreference,
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

describe('the choices Allowed models draws', () => {
  test('allows every model until the policy denies it, and writes a choice as deniedModels', () => {
    const start = policyOf({ policyRevision: 3, deployment: { deniedRegions: ['eu'] } });
    expect(isModelAllowed(start, 'claude-opus-5-5')).toBe(true);
    const denied = withModelAllowed(start, 'claude-opus-5-5', false);
    expect(isModelAllowed(denied, 'claude-opus-5-5')).toBe(false);
    expect(denied.deployment).toEqual({ deniedRegions: ['eu'], deniedModels: ['claude-opus-5-5'] });
    // Allowing it again leaves the policy as small as it was, and keeps the other fields.
    expect(withModelAllowed(denied, 'claude-opus-5-5', true)).toEqual(start);
    // Denying twice does not list a model twice, and allowing one leaves the others denied.
    const two = withModelAllowed(withModelAllowed(denied, 'claude-opus-5-5', false), 'm2', false);
    expect(two.deployment?.['deniedModels']).toEqual(['claude-opus-5-5', 'm2']);
    expect(withModelAllowed(two, 'm2', true).deployment?.['deniedModels']).toEqual([
      'claude-opus-5-5',
    ]);
  });

  test('reads cost and speed as one choice, and writes the choice back as the two preferences', () => {
    const start = policyOf({ policyRevision: 1 });
    expect(preferenceOf(start)).toBe('neither');
    const cost = withPreference(start, 'cost');
    expect(fieldOf(cost, 'your-preferences', 'costPreference')).toBe('lowest-cost');
    expect(fieldOf(cost, 'your-preferences', 'latencyPreference')).toBeUndefined();
    expect(preferenceOf(cost)).toBe('cost');
    const speed = withPreference(cost, 'speed');
    expect(fieldOf(speed, 'your-preferences', 'costPreference')).toBeUndefined();
    expect(preferenceOf(speed)).toBe('speed');
    expect(preferenceOf(withPreference(speed, 'both'))).toBe('both');
    // Neither removes both, and the entry that held nothing else goes with them.
    expect(withPreference(speed, 'neither')).toEqual(start);
    // A preference the page does not offer reads as neither.
    expect(
      preferenceOf(policyOf({ users: { [LOCAL_PROFILE]: { costPreference: 'balanced' } } })),
    ).toBe('neither');
  });

  test('counts what the person changed: each model, the preference and the effort', () => {
    const stored = policyOf({
      policyRevision: 2,
      deployment: { deniedModels: ['a'] },
      users: { [LOCAL_PROFILE]: { defaultEffort: 'high' } },
    });
    expect(changedChoices(stored, stored)).toBe(0);
    const edited = withPreference(withModelAllowed(stored, 'b', false), 'cost');
    expect(changedChoices(stored, edited)).toBe(2);
    expect(changedChoices(stored, withModelAllowed(edited, 'a', true))).toBe(3);
    expect(defaultEffortOf(stored)).toBe('high');
    expect(
      changedChoices(stored, withField(stored, 'your-preferences', 'defaultEffort', 'low')),
    ).toBe(1);
  });
});

/**
 * What the agent editor's model field offers: models grouped by provider, a provider with no key
 * listed on its own, what the model policy forbids, what a turned-off or retired row does, and the
 * abilities the catalog declares. The policy is matched as Operative's selector matches it: a denied
 * provider by name, a denied model by the row's own model name.
 */
import { describe, expect, test } from 'bun:test';

import { catalogFixture, catalogModelFixture } from '../../lib/bureau-stub.test-support.ts';
import {
  abilitiesOf,
  canonicalModel,
  choiceOf,
  firstAvailableModel,
  modelGroups,
  NO_RESTRICTIONS,
  restrictionsOf,
  unavailableReason,
} from './agent-editor-models.ts';

describe('the model policy', () => {
  test('forbids what the deployment and the Bureau layers deny, and nothing of the user’s own', () => {
    expect(
      restrictionsOf({
        deployment: { deniedProviders: ['openai'], deniedModels: ['gpt-4.1'] },
        bureau: { deniedProviders: ['gemini'] },
        users: { 'anonymous:local': { deniedProviders: ['anthropic'], deniedModels: ['x'] } },
        policyRevision: 3,
      }),
    ).toEqual({ deniedProviders: ['openai', 'gemini'], deniedModels: ['gpt-4.1'] });
  });

  test('forbids nothing for a setting that is absent or is not a policy', () => {
    expect(restrictionsOf(undefined)).toEqual(NO_RESTRICTIONS);
    expect(restrictionsOf('closed')).toEqual(NO_RESTRICTIONS);
    expect(
      restrictionsOf({ deployment: { deniedProviders: 'openai', deniedModels: [1, 'a'] } }),
    ).toEqual({ deniedProviders: [], deniedModels: ['a'] });
  });
});

describe('why a model cannot be chosen', () => {
  const restrictions = { deniedProviders: ['openai'], deniedModels: ['claude-haiku-5'] };

  test('names the policy first, then a row turned off, then a retired one', () => {
    const reasonOf = (row: Parameters<typeof catalogModelFixture>[0]) =>
      unavailableReason(catalogModelFixture(row), restrictions);
    expect(reasonOf({ provider: 'openai', model: 'a' })).toBe('provider-denied');
    expect(reasonOf({ provider: 'anthropic', model: 'claude-haiku-5' })).toBe('model-denied');
    expect(
      reasonOf({
        provider: 'anthropic',
        model: 'a',
        availability: 'unavailable',
        lifecycle: 'retired',
      }),
    ).toBe('turned-off');
    expect(reasonOf({ provider: 'anthropic', model: 'a', lifecycle: 'retired' })).toBe('retired');
    expect(reasonOf({ provider: 'anthropic', model: 'a' })).toBeUndefined();
    // A model name is not a provider name, and a deprecated or unknown row is still offered.
    expect(
      reasonOf({
        provider: 'anthropic',
        model: 'openai',
        lifecycle: 'deprecated',
        availability: 'unknown',
      }),
    ).toBeUndefined();
  });
});

describe('the groups', () => {
  const catalog = catalogFixture({
    models: [
      { provider: 'openai', model: 'gpt-4.1' },
      { provider: 'anthropic', model: 'claude-sonnet-5' },
      { provider: 'openai', model: 'gpt-4.1' },
      { provider: 'openai', model: 'o3', availability: 'unavailable' },
    ],
  });

  test('hold each model once, under its provider, in the catalog’s order', () => {
    const groups = modelGroups(catalog, undefined, NO_RESTRICTIONS, undefined);
    expect(groups.map((group) => [group.provider, group.connected])).toEqual([
      ['openai', true],
      ['anthropic', true],
    ]);
    expect(groups[0]?.choices.map((choice) => [choice.value, choice.unavailable])).toEqual([
      ['openai/gpt-4.1', undefined],
      ['openai/o3', 'turned-off'],
    ]);
  });

  test('add the providers the host reports without a key, last, and none that have a model', () => {
    const groups = modelGroups(
      catalog,
      [
        { name: 'gemini', hasKey: false },
        { name: 'openai', hasKey: false },
        { name: 'anthropic', hasKey: true },
      ],
      NO_RESTRICTIONS,
      undefined,
    );
    expect(groups.map((group) => [group.provider, group.connected])).toEqual([
      ['openai', true],
      ['anthropic', true],
      ['gemini', false],
    ]);
    expect(groups[2]?.choices).toEqual([]);
  });

  test('put a kept model the catalog lacks in its own provider’s group, connected or not', () => {
    const hostProviders = [
      { name: 'gemini', hasKey: false },
      { name: 'openai', hasKey: true },
    ];
    const inOpenai = modelGroups(catalog, hostProviders, NO_RESTRICTIONS, 'openai/gpt-3.5');
    expect(inOpenai.map((group) => [group.provider, group.connected])).toEqual([
      ['openai', true],
      ['anthropic', true],
      ['gemini', false],
    ]);
    expect(inOpenai[0]?.choices.at(-1)).toMatchObject({
      value: 'openai/gpt-3.5',
      unavailable: 'not-in-catalog',
    });

    // A provider with no row and no report of a missing key is not called unconnected.
    const elsewhere = modelGroups(catalog, undefined, NO_RESTRICTIONS, 'mistral/large');
    expect(elsewhere.at(-1)).toMatchObject({ provider: 'mistral', connected: true });

    const keyless = modelGroups(catalog, hostProviders, NO_RESTRICTIONS, 'gemini/pro');
    expect(keyless.at(-1)).toMatchObject({ provider: 'gemini', connected: false });
    expect(keyless.at(-1)?.choices.map((choice) => choice.value)).toEqual(['gemini/pro']);
  });

  test('pick the first model that can be chosen, and find a choice by its value', () => {
    const groups = modelGroups(
      catalog,
      undefined,
      { deniedProviders: ['openai'], deniedModels: [] },
      undefined,
    );
    expect(firstAvailableModel(groups)).toBe('anthropic/claude-sonnet-5');
    expect(choiceOf(groups, 'openai/o3')?.unavailable).toBe('provider-denied');
    expect(choiceOf(groups, 'openai/none')).toBeUndefined();
    const everything = { deniedProviders: ['openai', 'anthropic'], deniedModels: [] };
    expect(firstAvailableModel(modelGroups(catalog, undefined, everything, undefined))).toBe('');
  });
});

describe('a written model', () => {
  const catalog = catalogFixture();

  test('resolves to the option it names, whether it wrote the model or an alias of it', () => {
    expect(canonicalModel('anthropic/claude-sonnet-5', catalog)).toBe('anthropic/claude-sonnet-5');
    expect(canonicalModel('anthropic/sonnet', catalog)).toBe('anthropic/claude-sonnet-5');
  });

  test('resolves nothing for a model the catalog does not offer', () => {
    expect(canonicalModel('openai/gpt-4.1', catalog)).toBe('');
    expect(canonicalModel('anthropic/unknown', catalog)).toBe('');
    expect(canonicalModel('sonnet', catalog)).toBe('');
  });
});

describe('the abilities', () => {
  test('are the ones the catalog declares, with the windows in short form', () => {
    const row = catalogModelFixture({
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      contextWindowTokens: 1_000_000,
      maxOutputTokens: 64_000,
      structuredOutput: true,
      modalities: { text: { input: true }, image: { input: true } },
    });
    expect(abilitiesOf(row)).toEqual({
      context: '1M',
      maxOutput: '64K',
      has: ['tools', 'images', 'structuredOutput', 'streaming'],
    });
  });

  test('leave out what the model cannot do, which can be everything', () => {
    const row = catalogModelFixture({
      provider: 'openai',
      model: 'plain',
      tools: false,
      streaming: false,
      modalities: {},
    });
    expect(abilitiesOf(row).has).toEqual([]);
  });
});

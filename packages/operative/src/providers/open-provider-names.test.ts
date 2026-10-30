/**
 * COR-1870: the provider name set is open. A provider package or plugin brings a name, and nothing
 * under `packages/operative/src` has to learn it: the type accepts it, a contributed catalog row
 * and the capability answer carry it, and a request for a name no loaded provider carries is
 * unavailable instead of invalid.
 */
import { describe, expect, expectTypeOf, it } from 'bun:test';

import { isDelegatedAuthority } from '../child-run.ts';
import { getProviderCapabilities } from './capabilities.ts';
import { type BackendDescriptor, createModelCatalog } from './model-catalog.ts';
import type { ProviderDefinition } from './provider-definition.ts';
import { isProviderName, PROVIDER_NAME_PATTERN } from './provider-name.ts';
import { select } from './selection.ts';
import type { ProviderName } from './types.ts';

const FIXED_NOW = '2026-10-30T12:00:00.000Z';

/** A provider no file under `packages/operative/src` names, defined the way a plugin would. */
const exampleDefinition = {
  name: 'example',
  generate: () => async () => ({ content: 'example', toolCalls: [] }),
  stream: () => async () => ({ content: 'example', toolCalls: [] }),
} as const satisfies ProviderDefinition<'example'>;

/** The row the example provider contributes: a seed row re-attributed to the provider's name. */
function exampleRow(overrides: Partial<BackendDescriptor> = {}): BackendDescriptor {
  const [seed] = createModelCatalog({ now: () => FIXED_NOW }).descriptors;
  if (seed === undefined) throw new Error('the seed catalog has no rows');
  return {
    ...seed,
    provider: exampleDefinition.name,
    model: 'example-1',
    batchInference: true,
    explicitThinkingRequest: false,
    caching: true,
    serverSideTokenCounting: false,
    ...overrides,
  };
}

describe('ProviderName is open', () => {
  it('accepts a name no built-in provider carries', () => {
    const name: ProviderName = 'example';
    expect(name).toBe(exampleDefinition.name);
    expectTypeOf<'example'>().toExtend<ProviderName>();
    expectTypeOf<ProviderName>().toEqualTypeOf<string>();
  });

  it('matches the plugin-name grammar: a leading letter, then letters, digits and hyphens', () => {
    for (const name of [
      'anthropic',
      'openai',
      'gemini',
      'voyage',
      'ollama',
      'example',
      'a',
      'a1',
      'my-provider-2',
    ]) {
      expect(PROVIDER_NAME_PATTERN.test(name), name).toBe(true);
      expect(isProviderName(name), name).toBe(true);
    }
    for (const name of [
      '',
      '1password',
      '-leading',
      'trailing-',
      'Upper',
      'has space',
      'under_score',
      'a:b',
      'a/b',
      'a\n',
    ]) {
      expect(PROVIDER_NAME_PATTERN.test(name), JSON.stringify(name)).toBe(false);
      expect(isProviderName(name), JSON.stringify(name)).toBe(false);
    }
    for (const value of [undefined, null, 42, {}, ['example']]) {
      expect(isProviderName(value)).toBe(false);
    }
  });
});

describe('a provider that operative does not know', () => {
  it('produces a catalog row from its own descriptor', () => {
    const catalog = createModelCatalog({ now: () => FIXED_NOW, descriptors: [exampleRow()] });

    const rows = catalog.descriptors.filter((row) => row.provider === exampleDefinition.name);
    expect(rows.map((row) => row.model)).toEqual(['example-1']);
    expect(Object.isFrozen(rows[0])).toBe(true);
    // The built-in rows are untouched and come first.
    expect(catalog.descriptors.slice(0, -1)).toEqual([
      ...createModelCatalog({ now: () => FIXED_NOW }).descriptors,
    ]);
  });

  it("snapshots a contributed row instead of freezing or sharing the caller's object", () => {
    const row = { ...exampleRow() };
    const catalog = createModelCatalog({ descriptors: [row] });

    expect(Object.isFrozen(row)).toBe(false);
    row.contextWindowTokens = 1;
    expect(catalog.descriptors.at(-1)?.contextWindowTokens).not.toBe(1);
  });

  it('answers capability questions from its rows, and every flag false without them', () => {
    expect(getProviderCapabilities('example', { descriptors: [exampleRow()] })).toEqual({
      batchInference: true,
      explicitThinkingRequest: false,
      requestControlledContextCaching: true,
      serverSideTokenCounting: false,
    });
    const none = {
      batchInference: false,
      explicitThinkingRequest: false,
      requestControlledContextCaching: false,
      serverSideTokenCounting: false,
    };
    expect(getProviderCapabilities('example')).toEqual(none);
    expect(
      getProviderCapabilities('example', { descriptors: [exampleRow({ provider: 'other' })] }),
    ).toEqual(none);
  });

  it('keeps the answers the built-in providers always gave', () => {
    const rows = [exampleRow()];
    expect(getProviderCapabilities('voyage', { descriptors: rows }).batchInference).toBe(false);
    expect(getProviderCapabilities('anthropic', { descriptors: rows })).toEqual(
      getProviderCapabilities('anthropic'),
    );
  });

  it('refuses a contributed row whose provider is malformed or duplicates another row', () => {
    expect(() =>
      createModelCatalog({ descriptors: [exampleRow({ provider: 'Not A Provider' })] }),
    ).toThrow(/not a valid provider name/);
    expect(() => createModelCatalog({ descriptors: [exampleRow(), exampleRow()] })).toThrow(
      /duplicate row for example\/example-1/,
    );
    const [seed] = createModelCatalog().descriptors;
    expect(() => createModelCatalog({ descriptors: [{ ...exampleRow(), ...seed }] })).toThrow(
      /duplicate row/,
    );
  });

  it('is selectable when loaded and unavailable when it is not', () => {
    const request = {
      agentName: 'writer',
      catalogRevision: 1,
      policyRevision: 1,
      availabilitySnapshotRevision: 1,
    };
    const user = { allowedProviders: ['example'] };
    const plan = (catalog: ReturnType<typeof createModelCatalog>) =>
      select(request, {
        catalog,
        user,
        now: () => FIXED_NOW,
        newPlanId: () => 'plan-1',
      });

    const loaded = plan(createModelCatalog({ now: () => FIXED_NOW, descriptors: [exampleRow()] }));
    expect(loaded.outcome).toBe('selected');
    expect(loaded.selected?.provider).toBe('example');

    const missing = plan(createModelCatalog({ now: () => FIXED_NOW }));
    expect(missing.outcome).toBe('no-candidate');
    expect(missing.selected).toBeUndefined();
  });

  it('is a well-formed grant in a delegated authority', () => {
    expect(isDelegatedAuthority({ policyVersion: 'v1', grantedProviders: ['example'] })).toBe(true);
    expect(isDelegatedAuthority({ policyVersion: 'v1', grantedProviders: ['Example'] })).toBe(
      false,
    );
  });
});

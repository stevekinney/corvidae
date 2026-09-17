import { describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { createRegistry, defineTool } from '../src/core';

const makeDefinition = (name: string, version: string, deprecated = false) =>
  defineTool({
    name,
    version,
    description: `${name} tool`,
    input: z.object({ value: z.string() }),
    ...(deprecated ? { lifecycle: { deprecated: true } } : {}),
  });

describe('core registry versioning and aliases', () => {
  it('requires a version for get when using identity or string', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('alpha', '1.0.0'));
    expect(() => registry.get({ name: 'alpha' })).toThrow(
      'Tool identity must include a version for get/unregister',
    );
    expect(() => registry.get('default:alpha')).toThrow(
      'Tool identity must include a version for get/unregister',
    );
  });

  it('resolves highest semver by default', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('alpha', '1.0.0'));
    registry.register(makeDefinition('alpha', '2.1.0'));

    const resolved = registry.resolve({ name: 'alpha' });
    expect(resolved?.identity.version).toBe('2.1.0');
  });

  it('orders semver by minor and patch versions', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('minor', '1.2.0'));
    registry.register(makeDefinition('minor', '1.3.0'));
    registry.register(makeDefinition('minor', '1.3.1'));

    const resolved = registry.resolve({ name: 'minor' });
    expect(resolved?.identity.version).toBe('1.3.1');
  });

  it('falls back to registration order for non-semver versions', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('beta', 'alpha'));
    registry.register(makeDefinition('beta', 'beta'));

    const resolved = registry.resolve({ name: 'beta' });
    expect(resolved?.identity.version).toBe('beta');
  });

  it('skips deprecated tools unless allowDeprecated is true', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('gamma', '1.0.0'));
    registry.register(makeDefinition('gamma', '2.0.0', true));

    const resolved = registry.resolve({ name: 'gamma' });
    expect(resolved?.identity.version).toBe('1.0.0');

    const resolvedAllow = registry.resolve({ name: 'gamma' }, { allowDeprecated: true });
    expect(resolvedAllow?.identity.version).toBe('2.0.0');
  });

  it('rejects duplicate registrations unless override is true', () => {
    const registry = createRegistry();
    const definition = makeDefinition('dup', '1.0.0');
    registry.register(definition);
    expect(() => registry.register(definition)).toThrow('Tool already registered');

    const replacement = makeDefinition('dup', '1.0.0');
    registry.register(replacement, { override: true });
    const resolved = registry.get(replacement.id);
    expect(resolved?.id).toBe(replacement.id);
    expect(resolved?.identity).toEqual(replacement.identity);
  });

  it('rejects duplicate alias registrations without override', () => {
    const registry = createRegistry();
    const alpha = makeDefinition('alias', '1.0.0');
    const beta = makeDefinition('alias-two', '1.0.0');
    registry.register(alpha, { aliases: ['default:alias-key@1.0.0'] });
    expect(() => registry.register(beta, { aliases: ['default:alias-key@1.0.0'] })).toThrow(
      'Alias already registered',
    );
  });

  it('reassigns aliases when override is true', () => {
    const registry = createRegistry();
    const alpha = makeDefinition('alias-owner', '1.0.0');
    const beta = makeDefinition('alias-next', '1.0.0');
    registry.register(alpha, { aliases: ['default:alias-key@1.0.0'] });
    registry.register(beta, { aliases: ['default:alias-key@1.0.0'], override: true });

    expect(registry.aliases(alpha.id)).toEqual([]);
    expect(registry.resolve('default:alias-key@1.0.0')?.id).toBe(beta.id);
  });

  it('unregisters tools and clears aliases', () => {
    const registry = createRegistry();
    const alpha = makeDefinition('remove', '1.0.0');
    registry.register(alpha, { aliases: ['default:remove-alias@1.0.0'] });

    expect(registry.unregister(alpha.id)).toBe(true);
    expect(registry.resolve(alpha.id)).toBeUndefined();
    expect(registry.resolve('default:remove-alias@1.0.0')).toBeUndefined();
    expect(registry.unregister(alpha.id)).toBe(false);
  });

  it('resolves explicit versions and returns alias lists', () => {
    const registry = createRegistry();
    const alpha = makeDefinition('explicit', '1.0.0');
    registry.register(alpha, { aliases: ['default:explicit-alias@1.0.0'] });

    expect(registry.resolve({ name: 'explicit', version: '1.0.0' })?.id).toBe(alpha.id);
    expect(registry.get({ name: 'explicit', version: '1.0.0' })?.id).toBe(alpha.id);
    expect(registry.aliases(alpha.id)).toEqual(['default:explicit-alias@1.0.0']);
  });

  it('uses custom versionSelector when provided', () => {
    const registry = createRegistry({
      versionSelector: (definitions) =>
        definitions.find((definition) => definition.identity.version === '1.0.0'),
    });
    registry.register(makeDefinition('selector', '1.0.0'));
    registry.register(makeDefinition('selector', '2.0.0'));

    const resolved = registry.resolve({ name: 'selector' });
    expect(resolved?.identity.version).toBe('1.0.0');
  });

  it('resolves aliases and detects cycles', () => {
    const registry = createRegistry();
    const primary = makeDefinition('delta', '1.0.0');
    registry.register(primary, { aliases: ['default:delta-alias@1.0.0'] });
    expect(registry.resolve('default:delta-alias@1.0.0')?.id).toBe(primary.id);

    const cycleRegistry = createRegistry();
    const aliasOwner = makeDefinition('alias', '1.0.0');
    cycleRegistry.register(primary, { aliases: [aliasOwner.id] });
    cycleRegistry.register(aliasOwner, { aliases: [primary.id] });
    expect(() => cycleRegistry.resolve(primary.id)).toThrow('Alias cycle detected');
  });

  it('throws when alias resolution exceeds max depth', () => {
    const registry = createRegistry({ maxAliasDepth: 1 });
    const first = makeDefinition('depth-a', '1.0.0');
    const second = makeDefinition('depth-b', '1.0.0');
    registry.register(first, { aliases: [second.id] });
    registry.register(second, { aliases: ['default:depth-c@1.0.0'] });

    expect(() => registry.resolve('default:depth-c@1.0.0')).toThrow(
      'Alias resolution exceeded max depth',
    );
  });

  it('prefers release versions over prerelease versions', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('release', '1.0.0-alpha'));
    registry.register(makeDefinition('release', '1.0.0'));

    expect(registry.resolve({ name: 'release' })?.identity.version).toBe('1.0.0');
  });

  it('orders prerelease identifiers numerically', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('numeric-pre', '1.0.0-alpha.1'));
    registry.register(makeDefinition('numeric-pre', '1.0.0-alpha.2'));

    expect(registry.resolve({ name: 'numeric-pre' })?.identity.version).toBe('1.0.0-alpha.2');
  });

  it('orders prerelease identifiers by length', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('length-pre', '1.0.0-alpha'));
    registry.register(makeDefinition('length-pre', '1.0.0-alpha.1'));

    expect(registry.resolve({ name: 'length-pre' })?.identity.version).toBe('1.0.0-alpha');
  });

  it('orders numeric prerelease identifiers before alphanumeric', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('mixed-pre', '1.0.0-alpha.1'));
    registry.register(makeDefinition('mixed-pre', '1.0.0-alpha.beta'));

    expect(registry.resolve({ name: 'mixed-pre' })?.identity.version).toBe('1.0.0-alpha.1');
  });

  it('orders alphanumeric prerelease identifiers lexicographically', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('lex-pre', '1.0.0-alpha.beta'));
    registry.register(makeDefinition('lex-pre', '1.0.0-alpha.gamma'));

    expect(registry.resolve({ name: 'lex-pre' })?.identity.version).toBe('1.0.0-alpha.gamma');
  });

  it('orders shorter prerelease identifiers after longer ones when registered first', () => {
    const registry = createRegistry();
    registry.register(makeDefinition('short-pre', '1.0.0-alpha.1'));
    registry.register(makeDefinition('short-pre', '1.0.0-alpha'));

    expect(registry.resolve({ name: 'short-pre' })?.identity.version).toBe('1.0.0-alpha');
  });
});

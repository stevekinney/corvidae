import { describe, expect, test } from 'bun:test';

import {
  type PluginDependencyContext,
  type PluginManifest,
  pluginDependencyViolations,
} from './plugin-dependency-rules.ts';

const context: PluginDependencyContext = {
  workspaceNames: new Set([
    '@lostgradient/interborough-plugin',
    '@lostgradient/bureau',
    '@lostgradient/operative',
    '@lostgradient/operative-anthropic',
    '@lostgradient/weft',
    '@lostgradient/storage',
    '@lostgradient/storage-lmdb',
    '@lostgradient/lifecycle',
    '@lostgradient/memory',
    '@lostgradient/typescript',
    '@lostgradient/testing',
    '@lostgradient/interborough',
    '@lostgradient/plugin-other',
    '@lostgradient/plugin-example',
    'armorer',
  ]),
  applicationNames: new Set(['@lostgradient/interborough']),
  pluginNames: new Set(['@lostgradient/plugin-example', '@lostgradient/plugin-other']),
  verificationNames: new Set(['@lostgradient/testing']),
};

const allowed: PluginManifest = {
  name: '@lostgradient/plugin-example',
  dependencies: {
    '@lostgradient/interborough-plugin': 'workspace:*',
    '@lostgradient/operative': 'workspace:*',
    '@lostgradient/operative-anthropic': 'workspace:*',
    '@lostgradient/weft': 'workspace:*',
    '@lostgradient/storage': 'workspace:*',
    '@lostgradient/lifecycle': 'workspace:*',
    '@lostgradient/memory': 'workspace:*',
    armorer: 'workspace:*',
    zod: 'catalog:',
    'some-external-package': '^1.0.0',
  },
  devDependencies: {
    '@lostgradient/bureau': 'workspace:*',
    '@lostgradient/testing': 'workspace:*',
    '@lostgradient/typescript': 'workspace:*',
  },
};

describe('pluginDependencyViolations', () => {
  test('passes a manifest that keeps Bureau and testing workspaces in devDependencies', () => {
    expect(pluginDependencyViolations(allowed, context)).toEqual([]);
  });

  test.each([
    ['Bureau in dependencies', { '@lostgradient/bureau': 'workspace:*' }, 'Bureau'],
    ['an application', { '@lostgradient/interborough': 'workspace:*' }, 'application'],
    ['another plugin', { '@lostgradient/plugin-other': 'workspace:*' }, 'another plugin'],
    ['a testing workspace in dependencies', { '@lostgradient/testing': 'workspace:*' }, 'testing'],
  ])('fails %s', (_label, dependencies, message) => {
    const violations = pluginDependencyViolations(
      { name: allowed.name, dependencies: { zod: 'catalog:', ...dependencies } },
      context,
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain(message);
  });

  test('forbids an application and another plugin in devDependencies too', () => {
    const violations = pluginDependencyViolations(
      {
        name: allowed.name,
        devDependencies: {
          '@lostgradient/interborough': 'workspace:*',
          '@lostgradient/plugin-other': 'workspace:*',
        },
      },
      context,
    );
    expect(violations).toHaveLength(2);
  });

  test('reads peerDependencies and optionalDependencies like dependencies', () => {
    const violations = pluginDependencyViolations(
      {
        name: allowed.name,
        peerDependencies: { '@lostgradient/bureau': 'workspace:*' },
        optionalDependencies: { '@lostgradient/testing': 'workspace:*' },
      },
      context,
    );
    expect(violations).toHaveLength(2);
  });

  test('fails an internal workspace the list does not name', () => {
    const violations = pluginDependencyViolations(
      {
        name: allowed.name,
        dependencies: {
          '@lostgradient/storage-lmdb': 'workspace:*',
          '@lostgradient/typescript': 'workspace:*',
        },
      },
      context,
    );
    expect(violations).toHaveLength(2);
  });
});

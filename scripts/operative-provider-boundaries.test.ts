import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { workspaceParentDirectories } from './workspace-directories.ts';

/**
 * COR-1792: the dependency edges that keep Operative's model providers in their own packages.
 * `@lostgradient/operative` holds the provider-neutral engine, each `@lostgradient/operative-*`
 * package is one provider (or TypeSafe) that alone carries its vendor SDK, and Bureau names none
 * of them, so a change or dependency bump in one provider re-keys only that provider and its
 * importers. `operative-provider-boundaries.slow.test.ts` proves the cache-key consequence; this
 * file proves the edges.
 */

const root = join(import.meta.dir, '..');

const dependencyFields = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const;
type DependencyField = (typeof dependencyFields)[number];

/** The parts of a `package.json` this guard reads. */
interface Manifest {
  name: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
}

const operativeName = '@lostgradient/operative';
const bureauName = '@lostgradient/bureau';
const providerPrefix = '@lostgradient/operative-';

/** The provider packages issues 1 to 7 of the split created. */
const expectedProviderPackages = [
  `${providerPrefix}anthropic`,
  `${providerPrefix}openai`,
  `${providerPrefix}gemini`,
  `${providerPrefix}typesafe`,
];

/** Vendor SDKs and TanStack AI packages that only a provider package may name. */
const operativeForbiddenDependencies = [
  '@anthropic-ai/sdk',
  'openai',
  '@google/genai',
  '@tanstack/ai',
  '@tanstack/ai-typesafe',
];

function namesIn(manifest: Manifest, field: DependencyField): string[] {
  return Object.keys(manifest[field] ?? {});
}

function isProvider(name: string): boolean {
  return name.startsWith(providerPrefix);
}

/**
 * Every way Operative, the provider packages and Bureau break the boundaries, one sentence each.
 * The manifests are keyed by package name.
 */
function boundaryViolations(manifests: ReadonlyMap<string, Manifest>): string[] {
  const violations: string[] = [];

  const operative = manifests.get(operativeName);
  if (operative === undefined) {
    violations.push(`${operativeName} is not a workspace package`);
  } else {
    for (const field of dependencyFields) {
      for (const name of namesIn(operative, field)) {
        if (operativeForbiddenDependencies.includes(name) || isProvider(name)) {
          violations.push(`${operativeName} names ${name} in ${field}`);
        }
      }
    }
  }

  for (const [name, manifest] of manifests) {
    if (!isProvider(name)) continue;
    for (const field of dependencyFields) {
      for (const dependency of namesIn(manifest, field).filter(isProvider)) {
        violations.push(`${name} names the provider package ${dependency} in ${field}`);
      }
    }
  }

  const bureau = manifests.get(bureauName);
  if (bureau === undefined) {
    violations.push(`${bureauName} is not a workspace package`);
  } else {
    for (const field of dependencyFields) {
      for (const name of namesIn(bureau, field).filter(isProvider)) {
        violations.push(`${bureauName} names ${name} in ${field}`);
      }
    }
  }
  return violations;
}

function readWorkspaceManifests(): Map<string, Manifest> {
  const manifests = new Map<string, Manifest>();
  const directories = [
    ...workspaceParentDirectories.flatMap((parent) =>
      readdirSync(join(root, parent), { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => join(root, parent, entry.name)),
    ),
    join(root, 'scripts/browser-fixtures'),
  ];
  for (const directory of directories) {
    try {
      const manifest = JSON.parse(
        readFileSync(join(directory, 'package.json'), 'utf8'),
      ) as Manifest;
      manifests.set(manifest.name, manifest);
    } catch (error) {
      // A directory without a manifest is not a workspace (such as an ignored leftover).
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  return manifests;
}

const manifests = readWorkspaceManifests();

describe('the Operative provider packages', () => {
  test('exist, discovered from the workspace list', () => {
    const providers = [...manifests.keys()].filter(isProvider);
    for (const expected of expectedProviderPackages) expect(providers).toContain(expected);
  });

  test('keep the dependency edges that give each provider its own cache key', () => {
    expect(boundaryViolations(manifests)).toEqual([]);
  });
});

describe('the boundary guard', () => {
  function fixture(): Map<string, Manifest> {
    return new Map<string, Manifest>([
      [
        operativeName,
        { name: operativeName, dependencies: { zod: 'catalog:', armorer: 'workspace:*' } },
      ],
      [
        `${providerPrefix}anthropic`,
        {
          name: `${providerPrefix}anthropic`,
          dependencies: { [operativeName]: 'workspace:*', '@anthropic-ai/sdk': 'catalog:' },
        },
      ],
      [
        `${providerPrefix}openai`,
        {
          name: `${providerPrefix}openai`,
          dependencies: { [operativeName]: 'workspace:*', openai: 'catalog:' },
        },
      ],
      [bureauName, { name: bureauName, dependencies: { [operativeName]: 'workspace:*' } }],
    ]);
  }

  test('accepts the intended graph', () => {
    expect(boundaryViolations(fixture())).toEqual([]);
  });

  test('rejects a vendor SDK or TanStack AI package in any Operative dependency field', () => {
    const graph = fixture();
    graph.set(operativeName, {
      name: operativeName,
      dependencies: { '@anthropic-ai/sdk': 'catalog:' },
      devDependencies: { openai: 'catalog:' },
      peerDependencies: { '@tanstack/ai': 'catalog:' },
      optionalDependencies: { '@google/genai': 'catalog:', '@tanstack/ai-typesafe': 'catalog:' },
    });
    expect(boundaryViolations(graph)).toEqual([
      `${operativeName} names @anthropic-ai/sdk in dependencies`,
      `${operativeName} names openai in devDependencies`,
      `${operativeName} names @tanstack/ai in peerDependencies`,
      `${operativeName} names @google/genai in optionalDependencies`,
      `${operativeName} names @tanstack/ai-typesafe in optionalDependencies`,
    ]);
  });

  test('rejects Operative naming a provider package', () => {
    const graph = fixture();
    graph.set(operativeName, {
      name: operativeName,
      devDependencies: { [`${providerPrefix}openai`]: 'workspace:*' },
    });
    expect(boundaryViolations(graph)).toEqual([
      `${operativeName} names ${providerPrefix}openai in devDependencies`,
    ]);
  });

  test('rejects a provider package that depends on another', () => {
    const graph = fixture();
    const anthropic = graph.get(`${providerPrefix}anthropic`) as Manifest;
    anthropic.devDependencies = { [`${providerPrefix}openai`]: 'workspace:*' };
    expect(boundaryViolations(graph)).toEqual([
      `${providerPrefix}anthropic names the provider package ${providerPrefix}openai in devDependencies`,
    ]);
  });

  test('rejects Bureau naming a provider package in any dependency field', () => {
    const graph = fixture();
    const bureau = graph.get(bureauName) as Manifest;
    bureau.devDependencies = { [`${providerPrefix}gemini`]: 'workspace:*' };
    bureau.peerDependencies = { [`${providerPrefix}anthropic`]: 'workspace:*' };
    expect(boundaryViolations(graph)).toEqual([
      `${bureauName} names ${providerPrefix}gemini in devDependencies`,
      `${bureauName} names ${providerPrefix}anthropic in peerDependencies`,
    ]);
  });

  test('reports a missing Operative or Bureau', () => {
    expect(boundaryViolations(new Map())).toEqual([
      `${operativeName} is not a workspace package`,
      `${bureauName} is not a workspace package`,
    ]);
  });
});

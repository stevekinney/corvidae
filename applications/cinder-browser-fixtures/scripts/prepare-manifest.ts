import { createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

import { extractFixtures } from '@repo/testing';

import { appFixtureDeclarations } from '../src/app-fixture-declarations.ts';
import { assertUniqueFixtureNames } from '../src/manifest.ts';

const componentsRoot = resolve(
  import.meta.dirname,
  '..',
  '..',
  '..',
  'packages',
  'cinder',
  'src',
  'components',
);
const outputPath = resolve(import.meta.dirname, '..', '.playwright', 'manifest.json');
const appFixtureRoot = resolve(import.meta.dirname, '..', 'src', 'fixtures');

const results = await Promise.all([
  extractFixtures(componentsRoot),
  extractFixtures(resolve(componentsRoot, '../../../chat/src/lib/components')),
]);
const result = {
  entries: results.flatMap((entry) => entry.entries),
  violations: results.flatMap((entry) => entry.violations),
};
if (result.violations.length > 0) {
  throw new Error(result.violations.join('\n'));
}

const entries = result.entries.map(({ componentName, fixtures, contentHash }) => ({
  name: componentName,
  slug: componentName,
  route: `/page/${componentName}`,
  fixtures: fixtures.map((fixture) => ({
    name: fixture.name,
    mode: 'host' in fixture ? ('host' as const) : ('direct' as const),
    fixtureContentHash: contentHash,
    ...(fixture.interact !== undefined ? { interact: fixture.interact } : {}),
    ...(fixture.mask !== undefined ? { mask: fixture.mask } : {}),
    category: fixture.category,
  })),
}));
for (const [componentName, fixtureNames] of Object.entries(appFixtureDeclarations)) {
  const fixturePath = resolve(appFixtureRoot, `${componentName}.svelte`);
  const contentHash = createHash('sha256')
    .update(await Bun.file(fixturePath).text())
    .digest('hex');
  const entry = entries.find((candidate) => candidate.slug === componentName);
  const fixtures = fixtureNames.map((name) => ({
    name,
    mode: 'host' as const,
    fixtureContentHash: contentHash,
    category: 'visual-contract' as const,
  }));
  if (entry === undefined) {
    entries.push({
      name: componentName,
      slug: componentName,
      route: `/page/${componentName}`,
      fixtures,
    });
  } else {
    if (entry.fixtures === undefined) entry.fixtures = [];
    for (const fixture of fixtures) {
      if (!entry.fixtures.some((existing) => existing.name === fixture.name)) {
        entry.fixtures.push(fixture);
      }
    }
  }
}
assertUniqueFixtureNames(entries);
const digest = createHash('sha256').update(JSON.stringify(entries)).digest('hex');

await mkdir(resolve(outputPath, '..'), { recursive: true });
await Bun.write(outputPath, JSON.stringify({ digest, entries }, null, 2) + '\n');
console.log(`prepared ${entries.length} fixture groups at ${outputPath}`);

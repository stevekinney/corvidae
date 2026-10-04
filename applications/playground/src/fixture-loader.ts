import { existsSync } from 'node:fs';

import {
  loadFixtureFile as loadStaticFixtureFile,
  resolveFixtureFilePath,
  resolveFixtureHostPath,
  type FixtureFileEntry,
  type VisualFixture,
} from '@lostgradient/testing';

export { resolveFixtureFilePath, resolveFixtureHostPath };

export type LoadedFixtureFile = FixtureFileEntry;

export async function loadFixtureFile(sourcePath: string): Promise<LoadedFixtureFile | null> {
  if (!existsSync(sourcePath)) return null;
  const result = await loadStaticFixtureFile(sourcePath);
  if (result.kind === 'skipped') return null;
  if (result.kind === 'violations') throw new Error(result.violations.join('\n'));
  return result.entry;
}

export function findFixture(
  entry: LoadedFixtureFile,
  fixtureName: string,
): VisualFixture | undefined {
  return entry.fixtures.find((fixture) => fixture.name === fixtureName);
}

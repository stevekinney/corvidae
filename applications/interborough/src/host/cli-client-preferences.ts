import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { CliClientDependencies, CliConnection } from './cli-client.ts';

type Preferences = {
  readonly connections: readonly CliConnection[];
  readonly activeConnection?: string;
};

/** Resolve the local preferences path without consulting workspace state. */
export function preferencesLocation(dependencies: CliClientDependencies): string {
  return (
    dependencies.preferencesPath ??
    join(dependencies.environment?.['HOME'] ?? homedir(), '.interborough', 'cli-preferences.json')
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Read metadata-only connection preferences, treating malformed files as empty. */
export async function readPreferences(dependencies: CliClientDependencies): Promise<Preferences> {
  try {
    const value: unknown = JSON.parse(await readFile(preferencesLocation(dependencies), 'utf8'));
    if (!isRecord(value) || !Array.isArray(value['connections'])) return { connections: [] };
    const connections = value['connections'].filter(
      (entry): entry is CliConnection =>
        isRecord(entry) && typeof entry['name'] === 'string' && typeof entry['url'] === 'string',
    );
    return {
      connections,
      ...(typeof value['activeConnection'] === 'string'
        ? { activeConnection: value['activeConnection'] }
        : {}),
    };
  } catch {
    return { connections: [] };
  }
}

/** Atomically write metadata-only connection preferences with owner-only permissions. */
export async function writePreferences(
  preferences: Preferences,
  dependencies: CliClientDependencies,
): Promise<void> {
  const path = preferencesLocation(dependencies);
  await mkdir(join(path, '..'), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(preferences, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, path);
}

import { PUBLISHED_VERSIONS_PATH } from './playground-paths.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The version of `packageName` its public repository last published, as recorded in
 * `published-versions.json`, or `undefined` when the file records none. The workspace carries no
 * versions of its own, so this is the only version the Playground can show or stamp.
 */
export async function readLastPublishedVersion(packageName: string): Promise<string | undefined> {
  const recorded: unknown = await Bun.file(PUBLISHED_VERSIONS_PATH).json();
  const versions = isObject(recorded) ? recorded['lastPublishedVersions'] : undefined;
  const version = isObject(versions) ? versions[packageName] : undefined;
  return typeof version === 'string' ? version : undefined;
}

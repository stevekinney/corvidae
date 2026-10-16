import { PACKAGE_MAP_PATH } from './playground-paths.ts';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * The version of `packageName` the public mirror last published, as recorded in
 * `scripts/mirror/package-map.json`, or `undefined` when the map records none. The workspace
 * carries no versions of its own, so this is the only version the Playground can show or stamp.
 */
export async function readLastPublishedVersion(packageName: string): Promise<string | undefined> {
  const packageMap: unknown = await Bun.file(PACKAGE_MAP_PATH).json();
  const workspaces = isObject(packageMap) ? packageMap['workspaces'] : undefined;
  const entry = isObject(workspaces) ? workspaces[packageName] : undefined;
  const version = isObject(entry) ? entry['lastPublishedVersion'] : undefined;
  return typeof version === 'string' ? version : undefined;
}

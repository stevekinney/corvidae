import type { ContentLocation, DatabaseLocation } from '@lostgradient/bungalow';

/**
 * The SQLite file a database location names. The host runs on a local file until remote backends
 * land (COR-1761), so any other kind stops the start, naming the kind.
 */
export function sqliteDatabasePath(database: DatabaseLocation): string {
  if (database.kind === 'sqlite') return database.path;
  throw new Error(`The host does not support a ${database.kind} database yet.`);
}

/** The directory a content location names; any other kind stops the start, naming the kind. */
export function contentDirectoryPath(content: ContentLocation): string {
  if (content.kind === 'directory') return content.path;
  throw new Error(`The host does not support ${content.kind} content yet.`);
}

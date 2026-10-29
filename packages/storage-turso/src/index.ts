/**
 * The Turso storage adapter, `TursoStorage`, a `Storage` over a libSQL database: a local file or a
 * remote Turso instance, through the native `@libsql/client` driver. Browser and edge callers
 * import `@lostgradient/storage-turso/web` instead.
 *
 * @module storage-turso
 */
export type { TursoStorageOptions } from './turso-storage.ts';
export { TursoStorage } from './turso.ts';

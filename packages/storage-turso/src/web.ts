/**
 * The Turso storage adapter for browsers and edge runtimes, `TursoStorage` over a remote libSQL
 * database through the `@libsql/client/web` driver. Callers on Node or Bun import
 * `@lostgradient/storage-turso` instead.
 *
 * @module storage-turso/web
 */
export type { TursoStorageOptions } from './turso-storage.ts';
export { TursoStorage } from './turso-web.ts';

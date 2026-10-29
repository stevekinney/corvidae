import { TursoClientStorage, type TursoStorageOptions } from './turso-storage.ts';

/**
 * Storage adapter backed by Turso/libSQL, built on the native `@libsql/client` driver.
 *
 * It opens a local `file:` database, an in-memory one, or a remote Turso instance (`libsql://`).
 * The driver loads on first use, not at construction. A browser or edge caller, where the native
 * driver cannot load, imports `TursoStorage` from `@lostgradient/storage-turso/web` instead, which
 * speaks to a remote database only.
 *
 * @example
 * ```ts
 * import { TursoStorage } from '@lostgradient/storage-turso';
 *
 * await using storage = new TursoStorage({
 *   url: 'libsql://my-db.turso.io',
 * ...(process.env['TURSO_AUTH_TOKEN'] ? { authToken: process.env['TURSO_AUTH_TOKEN'] } : {}),
 * });
 * await storage.put('greeting', new TextEncoder().encode('hello'));
 * ```
 */
export class TursoStorage extends TursoClientStorage {
  constructor(options: TursoStorageOptions) {
    super(options, () => import('@libsql/client'));
  }
}

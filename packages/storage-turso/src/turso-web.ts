import { TursoClientStorage, type TursoStorageOptions } from './turso-storage.ts';

/**
 * Storage adapter backed by a remote Turso/libSQL database, built on the `@libsql/client/web`
 * driver for browsers and edge runtimes.
 *
 * The web driver speaks only to a network database (`libsql://`, `https://`, `wss://`), so a
 * `file:` URL is refused on the first operation. It has the same options and behavior as the
 * `TursoStorage` of `@lostgradient/storage-turso`, and the driver loads on first use, not at
 * construction.
 *
 * @example
 * ```ts
 * import { TursoStorage } from '@lostgradient/storage-turso/web';
 *
 * await using storage = new TursoStorage({
 *   url: 'libsql://my-db.turso.io',
 *   authToken: 'token-from-your-secret-store',
 * });
 * await storage.put('greeting', new TextEncoder().encode('hello'));
 * ```
 */
export class TursoStorage extends TursoClientStorage {
  constructor(options: TursoStorageOptions) {
    super(options, () => import('@libsql/client/web'));
  }
}

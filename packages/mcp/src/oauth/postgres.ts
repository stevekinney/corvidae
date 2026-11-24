import { PostgresStorage, type PostgresStorageOptions } from '@lostgradient/storage-postgres';
import { OAuthStore } from '../oauth-store.ts';

export function createPostgresOAuthStores(
  options: PostgresStorageOptions,
): OAuthStore & AsyncDisposable {
  const storage = new PostgresStorage(options);
  const store = new OAuthStore(storage);
  return Object.assign(store, { [Symbol.asyncDispose]: () => storage[Symbol.asyncDispose]() });
}

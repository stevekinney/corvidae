import { expect, test } from 'bun:test';
import { OAuthStore } from '../oauth-store.ts';
import { createPostgresOAuthStores } from './postgres.ts';

test('constructs a disposable PostgreSQL-backed issuer store', async () => {
  await using store = createPostgresOAuthStores({ url: 'postgresql://localhost/example' });
  expect(store).toBeInstanceOf(OAuthStore);
});

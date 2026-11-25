import { PostgresStorage, type PostgresStorageOptions } from '@lostgradient/storage-postgres';
import { OAuthStore } from '../oauth-store.ts';

export function createPostgresOAuthStores(
  options: PostgresStorageOptions,
): OAuthStore & AsyncDisposable {
  const storage = new PostgresStorage(options);
  const store = new OAuthStore(storage);
  return Object.assign(store, { [Symbol.asyncDispose]: () => storage[Symbol.asyncDispose]() });
}

/** Cross-host revocation hints. Durable authority remains the source of truth. */
export async function createPostgresGrantRevocationChannel(options: {
  url: string;
  issuer: string;
}) {
  options = { ...options };
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: options.url });
  const listeners = new Map<string, Set<() => void>>();
  let available = true;
  const closeStreams = () => {
    available = false;
    for (const callbacks of listeners.values()) for (const callback of callbacks) callback();
    listeners.clear();
  };
  client.on('error', closeStreams);
  client.on('end', closeStreams);
  client.on('notification', (message) => {
    if (message.channel !== 'corvidae_grant_revoked' || !message.payload) return;
    try {
      const payload: unknown = JSON.parse(message.payload);
      if (
        typeof payload !== 'object' ||
        payload === null ||
        !('issuer' in payload) ||
        !('grantId' in payload) ||
        payload.issuer !== options.issuer ||
        typeof payload.grantId !== 'string'
      )
        return;
      for (const callback of listeners.get(payload.grantId) ?? []) callback();
    } catch {
      /* Invalid notices cannot grant authority. */
    }
  });
  await client.connect();
  await client.query('LISTEN corvidae_grant_revoked');
  return {
    async publish(grantId: string) {
      if (!available) throw new Error('Grant revocation channel unavailable');
      await client.query('SELECT pg_notify($1, $2)', [
        'corvidae_grant_revoked',
        JSON.stringify({ issuer: options.issuer, grantId }),
      ]);
    },
    subscribe(grantId: string, callback: () => void) {
      if (!available) {
        queueMicrotask(callback);
        return () => {};
      }
      let callbacks = listeners.get(grantId);
      if (!callbacks) {
        callbacks = new Set();
        listeners.set(grantId, callbacks);
      }
      callbacks.add(callback);
      return () => {
        callbacks.delete(callback);
        if (callbacks.size === 0) listeners.delete(grantId);
      };
    },
    async [Symbol.asyncDispose]() {
      closeStreams();
      await client.end();
    },
  };
}

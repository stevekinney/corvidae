import { stubHostPaths } from '../../lib/bureau-stub.test-support.ts';
import { stubStorageFetch, type StubbedFetchCall } from './storage-fetch-stub.test-support.ts';

/** What a test serves: the keys in storage, and what the host says about itself. */
export interface StorageServerOptions {
  /** The stored values, by key. A `Uint8Array` is served as it is, a string as UTF-8. */
  readonly keys: Record<string, string | Uint8Array>;
  /** The Bureau's key prefixes `/host/storage` answers with, or `null` to refuse the request. */
  readonly bureauPrefixes?: readonly string[] | null;
  /** The mode `/host/paths` answers for. Local by default. */
  readonly mode?: 'local' | 'remote';
  /** Fails the scan with this status, for the error state. */
  readonly scanStatus?: number;
  /** Whether the storage reports `conditionalBatch`. True by default. */
  readonly conditionalBatch?: boolean;
}

/** The capabilities `weft.storage.capabilities` answers with. */
export const STORAGE_CAPABILITIES = {
  persistence: 'local',
  readAfterWrite: 'linearizable',
  scanConsistency: 'snapshot',
  atomicBatch: true,
  conditionalBatch: true,
  boundedRangeDelete: true,
} as const;

const bytesOf = (value: string | Uint8Array): Uint8Array =>
  typeof value === 'string' ? new TextEncoder().encode(value) : value;

interface WireOperation {
  readonly type: 'put' | 'delete';
  readonly key: string;
  readonly value?: string;
}

/** Answers a conditional batch as the engine does: nothing is written unless every condition holds. */
function applyConditionalBatch(store: Map<string, Uint8Array>, body: string): Response {
  const request = JSON.parse(body) as {
    conditions: { key: string; expectedValue: string | null }[];
    operations: WireOperation[];
  };
  const holds = request.conditions.every(({ key, expectedValue }) => {
    const current = store.get(key);
    return expectedValue === null
      ? current === undefined
      : current !== undefined && Buffer.from(current).toString('base64') === expectedValue;
  });
  if (holds) {
    for (const operation of request.operations) {
      if (operation.type === 'delete') store.delete(operation.key);
      else store.set(operation.key, Buffer.from(operation.value ?? '', 'base64'));
    }
  }
  return Response.json({ applied: holds });
}

/**
 * Installs a `fetch` that answers as the host does: the scan, a key's write and delete, the
 * capabilities call, `/host/storage` and `/host/paths`. A write changes what the next scan returns,
 * as a real store would.
 */
export function serveStorage(options: StorageServerOptions): {
  readonly calls: StubbedFetchCall[];
  readonly store: Map<string, Uint8Array>;
  /** Change what the server answers while a test runs. */
  readonly control: { scanStatus: number | undefined; refuseWrites: boolean };
  readonly restore: () => void;
} {
  const control: { scanStatus: number | undefined; refuseWrites: boolean } = {
    scanStatus: options.scanStatus,
    refuseWrites: false,
  };
  const store = new Map<string, Uint8Array>(
    Object.entries(options.keys).map(([key, value]) => [key, bytesOf(value)]),
  );
  const stub = stubStorageFetch(async (call) => {
    const url = new URL(call.url, 'http://localhost');
    if (url.pathname === '/host/storage') {
      return options.bureauPrefixes === null
        ? new Response('no', { status: 500 })
        : Response.json({ bureauKeyPrefixes: options.bureauPrefixes ?? [] });
    }
    if (url.pathname === '/host/paths') {
      return Response.json(
        stubHostPaths('/home/me/agents', '/home/me/workflows', options.mode ?? 'local'),
      );
    }
    if (call.body !== undefined && call.body.includes('weft.storage.capabilities')) {
      return Response.json({
        jsonrpc: '2.0',
        id: 1,
        result: {
          ...STORAGE_CAPABILITIES,
          conditionalBatch: options.conditionalBatch ?? true,
        },
      });
    }
    if (url.pathname === '/v1/storage' && call.method === 'GET') {
      if (control.scanStatus !== undefined) {
        return Response.json(
          { error: 'The store is unavailable.' },
          { status: control.scanStatus },
        );
      }
      const prefix = url.searchParams.get('prefix') ?? '';
      const gt = url.searchParams.get('gt');
      const gte = url.searchParams.get('gte');
      const limit = Number(url.searchParams.get('limit') ?? '100');
      const rows = [...store.entries()]
        .toSorted(([first], [second]) => (first < second ? -1 : first > second ? 1 : 0))
        .filter(
          ([key]) =>
            key.startsWith(prefix) && (gt === null || key > gt) && (gte === null || key >= gte),
        )
        .slice(0, limit)
        .map(([key, value]) =>
          JSON.stringify({ key, value: Buffer.from(value).toString('base64') }),
        );
      return new Response(rows.length > 0 ? `${rows.join('\n')}\n` : '', {
        headers: { 'Content-Type': 'application/x-ndjson' },
      });
    }
    if (control.refuseWrites && call.method !== 'GET') {
      return Response.json(
        { error: 'Raw storage access requires storage:admin.' },
        { status: 403 },
      );
    }
    if (url.pathname === '/v1/storage/-/conditional-batch' && call.method === 'POST') {
      return applyConditionalBatch(store, call.body ?? '{}');
    }
    const key = decodeURIComponent(url.pathname.replace('/v1/storage/', ''));
    if (call.method === 'PUT') {
      store.set(key, new TextEncoder().encode(call.body ?? ''));
      return new Response(null, { status: 204 });
    }
    if (call.method === 'DELETE') {
      store.delete(key);
      return new Response(null, { status: 204 });
    }
    return new Response('unexpected', { status: 500 });
  });
  return { calls: stub.calls, store, control, restore: stub.restore };
}

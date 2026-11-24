import { Database } from 'bun:sqlite';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

export type RecoveryManifest = {
  readonly schemaVersion: number;
  readonly schema: readonly string[];
  readonly content: Readonly<Record<string, string>>;
  readonly identities: Readonly<Record<string, string>>;
};

/** Inspect a quiesced home without opening it through the application.
 * Identities must come from independent readback, not the seed inputs.
 */
export async function recoveryManifest(
  home: string,
  assetDigests: readonly string[],
  identities: Readonly<Record<string, string>>,
): Promise<RecoveryManifest> {
  const database = new Database(join(home, 'database.sqlite'), { readonly: true });
  try {
    const version = database.query<{ user_version: number }, []>('PRAGMA user_version').get();
    if (version === null) throw new Error('SQLite did not return its schema version');
    const schema = database
      .query<{ sql: string }, []>(
        'SELECT sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name',
      )
      .all()
      .map((row) => row.sql);
    const content: Record<string, string> = Object.create(null);
    const assetId = identities['assetId'];
    if (assetId !== undefined) {
      const record = database
        .query<{ value: Uint8Array }, [string]>('SELECT value FROM kv WHERE key = ?')
        .get(`asset:v1:record:${assetId}`);
      if (record === null) throw new Error('Saved asset record is missing');
      const asset = JSON.parse(new TextDecoder().decode(record.value)) as {
        assetId?: string;
        digest?: string;
        state?: string;
      };
      if (
        asset.assetId !== assetId ||
        asset.state !== 'available' ||
        !assetDigests.includes(asset.digest?.replace(/^sha256:/, '') ?? '')
      )
        throw new Error('Saved asset record differs');
    }
    for (const digest of assetDigests.toSorted()) {
      if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid asset digest');
      const row = database
        .query<{ value: Uint8Array }, [string]>('SELECT value FROM kv WHERE key = ?')
        .get(`asset:v1:blob:sha256:${digest}`);
      if (row === null) throw new Error(`Missing asset: ${digest}`);
      const bytes = Buffer.from(new TextDecoder().decode(row.value), 'base64');
      const actual = createHash('sha256').update(bytes).digest('hex');
      if (actual !== digest) throw new Error(`Asset digest mismatch: ${digest}`);
      content[digest] = actual;
    }
    return { schemaVersion: version.user_version, schema, content, identities: { ...identities } };
  } finally {
    database.close();
  }
}

export function assertRecoveryManifest(actual: RecoveryManifest, expected: RecoveryManifest): void {
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, entry: unknown) =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        ? Object.fromEntries(
            Object.entries(entry).toSorted(([left], [right]) => left.localeCompare(right)),
          )
        : entry,
    );
  if (canonical(actual) !== canonical(expected)) throw new Error('Recovery manifest mismatch');
}

/** Check the persisted conversation, not the transient watch stream, for the resumed result. */
export function assertOneRefundResult(
  messages: Record<
    string,
    { toolResult?: { callId?: string; outcome?: string; content?: unknown } }
  >,
  callId: string,
): void {
  const results = Object.values(messages).filter(
    (message) => message.toolResult?.callId === callId && message.toolResult.outcome === 'success',
  );
  const content = results[0]?.toolResult?.content;
  if (
    results.length !== 1 ||
    content === null ||
    typeof content !== 'object' ||
    !Object.hasOwn(content, 'orderId') ||
    Reflect.get(content, 'orderId') !== 'order-1001' ||
    !Object.hasOwn(content, 'refundedCents') ||
    Reflect.get(content, 'refundedCents') !== 4200
  )
    throw new Error('Expected exactly one durable refund result');
}

/** Verify a restored home independently while its previous host serves read-only requests. */
export async function verifyRecovery(
  home: string,
  url: string,
  manifestPath: string,
): Promise<void> {
  const expected = JSON.parse(await readFile(manifestPath, 'utf8')) as RecoveryManifest;
  const response = await fetch(`${url}/bureau/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.reviews.list', params: {} }),
  });
  if (!response.ok) throw new Error(`Review readback returned ${response.status}`);
  const payload = (await response.json()) as {
    result?: { reviews?: Array<{ id: string; runId: string; sessionId: string }> };
  };
  const review = payload.result?.reviews?.find(
    (entry) => entry.id === expected.identities['reviewId'],
  );
  if (!review) throw new Error('Saved review is not pending');
  const settingsResponse = await fetch(`${url}/bureau/jsonrpc`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'bureau.settings.get', params: {} }),
  });
  if (!settingsResponse.ok)
    throw new Error(`Settings readback returned ${settingsResponse.status}`);
  const settings = (await settingsResponse.json()) as {
    result?: { values?: Record<string, unknown> };
  };
  const wakeup = JSON.stringify(settings.result?.values?.['tools.wakeup']);
  if (wakeup === undefined) throw new Error('Saved setting is missing');
  const identities = {
    ...expected.identities,
    reviewId: review.id,
    runId: review.runId,
    sessionId: review.sessionId,
    wakeup,
  };
  assertRecoveryManifest(
    await recoveryManifest(home, Object.keys(expected.content), identities),
    expected,
  );
}

if (import.meta.main) {
  const [home, url, manifest] = Bun.argv.slice(2);
  if (!home || !url || !manifest) throw new Error('Expected home, host URL, and manifest path');
  await verifyRecovery(home, url, manifest);
  console.info('Recovery manifest verified');
}

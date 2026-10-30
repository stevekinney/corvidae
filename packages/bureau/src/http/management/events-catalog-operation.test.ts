/**
 * COR-1940 — `bureau.events.catalog` over a real Bureau and its handler: any authenticated caller
 * reads the catalog, and it lists exactly the published kinds.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import { bureauEventCatalog } from '../../bureau-event-catalog.ts';
import { PUBLISHED_BUREAU_EVENT_KINDS } from '../../bureau-event-feed.ts';
import { BUREAU_HANDLER_OPERATIONS } from '../create-bureau-handler.ts';
import { eventsCatalogOperation } from './events-catalog-operation.ts';
import { openBureau, type OpenedBureau, rpc } from './management-fixtures.test-support.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).toReversed()) await cleanup();
});

async function open(): Promise<OpenedBureau> {
  const opened = await openBureau();
  cleanups.push(() => opened.dispose());
  return opened;
}

describe('bureau.events.catalog', () => {
  it('is served, described, read-only, and open to any authenticated caller', () => {
    expect(BUREAU_HANDLER_OPERATIONS).toContain(eventsCatalogOperation);
    expect(eventsCatalogOperation.destructive).toBe(false);
    expect(eventsCatalogOperation.access).toEqual({ kind: 'authenticated' });
    expect(eventsCatalogOperation.description?.length ?? 0).toBeGreaterThan(40);
  });

  it('lists exactly the published kinds, each with a description and its payload fields', async () => {
    const opened = await open();
    // A caller with no scope at all reads it.
    const body = await rpc(opened.handler, 'bureau.events.catalog', {}, 'alice-key');
    expect(body.error).toBeUndefined();
    const events = body.result!['events'] as Array<{
      kind: string;
      description: string;
      origin: string;
      payload: Array<{ name: string; type: string; optional: boolean }>;
    }>;

    expect(events.map((event) => event.kind)).toEqual([...PUBLISHED_BUREAU_EVENT_KINDS]);
    expect(events).toEqual(
      bureauEventCatalog().map((entry) => ({
        kind: entry.kind,
        description: entry.description,
        origin: entry.origin,
        payload: entry.payload.map((field) => ({ ...field })),
      })),
    );
    expect(events.find((event) => event.kind === 'notification.created')?.origin).toBe(
      'unattributed',
    );
    expect(events.find((event) => event.kind === 'run.registered')?.payload).toEqual([
      { name: 'runId', type: 'string', optional: false },
    ]);
  });

  it('refuses a request with no credential', async () => {
    const opened = await open();
    const body = await rpc(opened.handler, 'bureau.events.catalog', {}, 'no-such-key');
    expect(body.error).toBeDefined();
  });
});

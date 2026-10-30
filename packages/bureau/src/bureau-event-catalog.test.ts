/**
 * COR-1940 — the event catalog describes exactly the published kinds, so a new published kind
 * without an entry fails here (and at compile time).
 */
import { describe, expect, it } from 'bun:test';

import {
  BUREAU_EVENT_CATALOG,
  bureauEventCatalog,
  type BureauEventCatalogEntry,
} from './bureau-event-catalog.ts';
import { PUBLISHED_BUREAU_EVENT_KINDS, projectBureauEvent } from './bureau-event-feed.ts';
import {
  BureauDisposedEvent,
  DiagnosticEvent,
  RunRegisteredEvent,
  RunSettledEvent,
} from './events.ts';

describe('the Bureau event catalog', () => {
  it('lists exactly PUBLISHED_BUREAU_EVENT_KINDS, in order', () => {
    expect(bureauEventCatalog().map((entry) => entry.kind)).toEqual([
      ...PUBLISHED_BUREAU_EVENT_KINDS,
    ]);
    expect(Object.keys(BUREAU_EVENT_CATALOG).toSorted()).toEqual(
      [...PUBLISHED_BUREAU_EVENT_KINDS].toSorted(),
    );
    for (const entry of bureauEventCatalog()) {
      expect(BUREAU_EVENT_CATALOG[entry.kind].kind).toBe(entry.kind);
    }
  });

  it('describes every kind, and names each payload field once', () => {
    for (const entry of bureauEventCatalog()) {
      expect(entry.description.length).toBeGreaterThanOrEqual(15);
      const names = entry.payload.map((field) => field.name);
      expect(new Set(names).size).toBe(names.length);
    }
  });

  it('describes the payloads the feed projects: every key is a field, every required field is present', () => {
    const projected = [
      new RunRegisteredEvent('run-1'),
      new RunSettledEvent('run-1'),
      new DiagnosticEvent('warn', 'hooks'),
      new BureauDisposedEvent(),
    ].map((event) => projectBureauEvent(event)!);
    expect(projected.map((event) => event.kind)).toEqual([
      'run.registered',
      'run.settled',
      'diagnostic',
      'bureau.disposed',
    ]);
    for (const event of projected) {
      const entry: BureauEventCatalogEntry =
        BUREAU_EVENT_CATALOG[event.kind as keyof typeof BUREAU_EVENT_CATALOG];
      const declared = entry.payload.map((field) => field.name);
      expect(declared).toEqual(expect.arrayContaining(Object.keys(event.payload)));
      for (const field of entry.payload.filter((candidate) => !candidate.optional)) {
        expect(Object.keys(event.payload)).toContain(field.name);
      }
    }
  });
});

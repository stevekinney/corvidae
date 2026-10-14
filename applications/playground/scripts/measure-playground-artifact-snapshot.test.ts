import { afterEach, describe, expect, it } from 'bun:test';

// Importing the artifact owner directly also places this file in its own `bun test` process
// (see `run-tests.ts`), because it shares module state with the build pipeline.
import {
  clearPageArtifacts,
  evictPageArtifacts,
  publishPageArtifacts,
} from '../src/build-artifacts-shared.ts';
import { pageEntryByName } from '../src/page-bundle.ts';
import { sseClients } from '../src/sse-broadcast.ts';
import { snapshotRetainedArtifacts } from './measure-playground-artifact-snapshot.ts';

afterEach(() => {
  pageEntryByName.clear();
  clearPageArtifacts();
});

describe('snapshotRetainedArtifacts', () => {
  it('starts empty in a fresh process', () => {
    const snapshot = snapshotRetainedArtifacts();
    expect(snapshot.totalArtifacts).toBe(0);
    expect(snapshot.totalArtifactBytes).toBe(0);
    expect(snapshot.page).toEqual({ entryPointers: 0, artifacts: 0, artifactBytes: 0 });
  });

  it('reads the entry pointers, artifacts, and UTF-8 bytes the page owner holds', () => {
    publishPageArtifacts(
      'button',
      new Map([
        ['page-button-abc12345.js', 'import"./chunk-1.js";'],
        ['chunk-1.js', 'é'],
      ]),
    );
    pageEntryByName.set('button', 'page-button-abc12345.js');

    const snapshot = snapshotRetainedArtifacts();
    expect(snapshot.page).toEqual({ entryPointers: 1, artifacts: 2, artifactBytes: 21 + 2 });
    expect(snapshot.totalArtifacts).toBe(2);
  });

  it('reflects the owner releasing a page', () => {
    publishPageArtifacts('button', new Map([['chunk-1.js', 'x']]));
    evictPageArtifacts('button');
    expect(snapshotRetainedArtifacts().page.artifacts).toBe(0);
  });

  it('does not change the state it reads', () => {
    publishPageArtifacts('button', new Map([['chunk-1.js', 'x']]));
    const first = snapshotRetainedArtifacts();
    expect(snapshotRetainedArtifacts()).toEqual(first);
  });

  it('counts the live-reload streams the server holds', () => {
    const controller = {} as ReadableStreamDefaultController<string>;
    sseClients.add(controller);
    try {
      expect(snapshotRetainedArtifacts().liveReloadSubscribers).toBe(1);
    } finally {
      sseClients.delete(controller);
    }
    expect(snapshotRetainedArtifacts().liveReloadSubscribers).toBe(0);
  });
});

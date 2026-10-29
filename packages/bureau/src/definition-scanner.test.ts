/**
 * COR-1702 — the scan-and-diff layer between a definition source and a catalog: a source that
 * notifies from inside `watch`, and a reload that fails after a write that already happened.
 */
import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { describe, expect, it } from 'bun:test';

import { createDefinitionScanner, type ScannedEntry } from './definition-scanner';
import { createMemoryDefinitionSource } from './testing/memory-definition-source.test-support';
import type { DefinitionSource } from './sources/definition-source';

const decoder = new TextDecoder();

interface Entry extends ScannedEntry {
  readonly text: string;
}

function scannerOver(
  source: DefinitionSource,
  runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' }),
) {
  const diagnostics: string[] = [];
  const scanner = createDefinitionScanner<Entry>({
    source,
    label: 'test directory',
    runtime,
    diagnose: (message) => diagnostics.push(message),
    revision: () => 0,
    evaluate: (id, bytes, hash, revision) => ({ id, hash, revision, text: decoder.decode(bytes) }),
    tooLarge: (id, _size, revision) => ({ id, hash: undefined, revision, text: '' }),
    unreadable: (id, _error, revision) => ({ id, hash: undefined, revision, text: '' }),
    sameSignature: (before, after) => before.hash === after.hash,
    isRejected: (entry) => entry.text.startsWith('invalid'),
  });
  return { scanner, diagnostics, runtime };
}

describe('a source whose watch notifies before it returns', () => {
  it('is subscribed once, does not recurse, and applies the buffered change once', async () => {
    const memory = createMemoryDefinitionSource('workflow');
    memory.set('one', 'first');
    let subscriptions = 0;
    const source: DefinitionSource = {
      load: () => memory.source.load(),
      write: (id, bytes, options) => memory.source.write(id, bytes, options),
      delete: (id, options) => memory.source.delete(id, options),
      watch(listener) {
        subscriptions += 1;
        // A source that has a change waiting tells its new listener at once, synchronously.
        listener({ added: ['one'], changed: [], removed: [] });
        return () => undefined;
      },
    };
    const { scanner } = scannerOver(source);

    await scanner.refresh();

    expect(subscriptions).toBe(1);
    expect(memory.loads()).toBe(1);
    expect([...scanner.entries().keys()]).toEqual(['one']);
    await scanner.close();
  });
});

describe('reload', () => {
  it('rejects when the source cannot be read back, says the write is durable, and repairs on its own', async () => {
    const memory = createMemoryDefinitionSource('workflow');
    const { scanner, diagnostics, runtime } = scannerOver(memory.source);
    await scanner.refresh();
    expect([...scanner.entries().keys()]).toEqual([]);

    await memory.source.write('late', new TextEncoder().encode('written'), { expectedHash: null });
    memory.failNextLoad(new Error('store unavailable'));
    const failure = await scanner.reload().catch((thrown: unknown) => thrown);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('store unavailable');
    expect((failure as Error).message).toContain('durable');
    expect(diagnostics.length).toBeGreaterThan(0);
    expect([...scanner.entries().keys()]).toEqual([]);

    // Nothing reports a change and nobody asks: the rescan the failure scheduled converges.
    const converged = new Promise<void>((resolve) => {
      scanner.onChange(() => resolve());
    });
    await runtime.advance(60_000);
    await converged;
    expect([...scanner.entries().keys()]).toEqual(['late']);
    await scanner.close();
  });

  it('resolves when the reload succeeds', async () => {
    const memory = createMemoryDefinitionSource('workflow');
    const { scanner } = scannerOver(memory.source);
    memory.set('one', 'first');
    await scanner.reload();
    expect([...scanner.entries().keys()]).toEqual(['one']);
    await scanner.close();
  });
});

describe('a change report', () => {
  it('names the added and changed identifiers whose definition is rejected now (COR-1721)', async () => {
    const memory = createMemoryDefinitionSource('workflow');
    memory.set('kept', 'valid');
    memory.set('broken-later', 'valid');
    memory.set('gone', 'valid');
    const { scanner } = scannerOver(memory.source);
    const changes: unknown[] = [];
    scanner.onChange((change) => changes.push(change));
    await scanner.refresh();

    memory.set('broken-later', 'invalid now');
    memory.set('fresh-invalid', 'invalid from the start');
    memory.set('fresh-valid', 'valid');
    memory.remove('gone');
    await scanner.refresh();

    expect(changes).toEqual([
      { added: ['kept', 'broken-later', 'gone'], changed: [], removed: [], rejected: [] },
      {
        added: ['fresh-invalid', 'fresh-valid'],
        changed: ['broken-later'],
        removed: ['gone'],
        rejected: ['fresh-invalid', 'broken-later'],
      },
    ]);
    await scanner.close();
  });
});

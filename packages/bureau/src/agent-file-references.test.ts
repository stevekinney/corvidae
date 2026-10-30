/**
 * COR-1866 — an agent file's `references`: the catalog reads the documents beside the file on every
 * scan, makes a missing or oversized one a problem naming the path, folds each document's digest
 * into the agent's revision identity, notices an edit to one, and keeps the text beside the run's
 * snapshot and only the digest on a saved version.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { createManualRuntimeServices } from '@lostgradient/lifecycle';
import { MemoryStorage, textValueStore } from '@lostgradient/storage';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterEach, describe, expect, it } from 'bun:test';

import {
  AGENT_REFERENCE_SIZE_LIMIT,
  AGENT_REFERENCES_TOTAL_SIZE_LIMIT,
  AgentFileError,
  parseAgentFile,
} from './agent-file';
import { readFileAgentBinding } from './agent-file-catalog';
import { DIRECTORY_POLL_INTERVAL_MILLISECONDS } from './sources/watched-directory';
import {
  referenceIdentity,
  renderInstructions,
  type AgentReferenceDocument,
} from './agent-reference-documents';
import { createAgentSnapshotStore } from './agent-snapshot-store';
import { nodeAgentFileOperations } from './sources/agent-file-operations';
import { createMemoryDefinitionSource } from './testing/memory-definition-source.test-support';
import {
  type AgentFileFixture,
  agentFileText,
  createAgentFileFixture,
  KNOWN_MODEL,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';

const fixtures: AgentFileFixture[] = [];

async function start(options: Parameters<typeof createAgentFileFixture>[0] = {}) {
  const fixture = await createAgentFileFixture({ watch: false, ...options });
  fixtures.push(fixture);
  await fixture.catalog.refresh();
  return fixture;
}

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) await fixture.dispose();
});

const WITH_REFERENCES = agentFileText(
  { name: 'Helper', model: KNOWN_MODEL, references: '[style.md, docs/glossary.txt]' },
  'You are helpful.\n',
);

/** A fixture with the two documents `WITH_REFERENCES` names, and the agent loaded. */
async function startWithDocuments() {
  const fixture = await start();
  await mkdir(join(fixture.directory, 'docs'));
  await fixture.put('style.md', 'Be brief.\n');
  await fixture.put('docs/glossary.txt', 'Order: a purchase.\n');
  await fixture.put('helper.md', WITH_REFERENCES);
  await fixture.catalog.refresh();
  return fixture;
}

const entryOf = (fixture: AgentFileFixture) => {
  const listing = fixture.catalog.list().find((candidate) => candidate.id === 'helper');
  if (listing === undefined) throw new Error('Expected the helper agent to be listed.');
  return listing;
};

function bindingOf(fixture: AgentFileFixture) {
  const agent = fixture.catalog.find('helper');
  const binding = agent === undefined ? undefined : readFileAgentBinding(agent);
  if (binding === undefined) throw new Error('Expected the helper agent to be ready.');
  return binding;
}

describe('an agent whose references read', () => {
  it('is ready, with the documents in the order the file lists them', async () => {
    const fixture = await startWithDocuments();
    expect(entryOf(fixture).state).toBe('ready');
    const { referenceDocuments, definition } = bindingOf(fixture);
    expect(definition.references).toEqual(['style.md', 'docs/glossary.txt']);
    expect(referenceDocuments?.map(({ path, content }) => [path, content])).toEqual([
      ['style.md', 'Be brief.\n'],
      ['docs/glossary.txt', 'Order: a purchase.\n'],
    ]);
  });

  it('is identified by the file’s hash when it has no references, and by a folded hash when it has', async () => {
    const fixture = await startWithDocuments();
    await fixture.put('plain.md', validAgentFile());
    await fixture.catalog.refresh();
    const plain = fixture.catalog.find('plain');
    const plainBinding = plain === undefined ? undefined : readFileAgentBinding(plain);
    const plainListing = fixture.catalog.list().find((candidate) => candidate.id === 'plain');
    expect(plainBinding?.hash).toBe(plainListing?.definitionHash);

    const listing = entryOf(fixture);
    const binding = bindingOf(fixture);
    expect(binding.hash).not.toBe(listing.definitionHash);
    expect(binding.hash).toBe(
      referenceIdentity(listing.definitionHash ?? '', binding.referenceDocuments ?? []),
    );
    // `expectedHash` stays the file's bytes.
    const read = await fixture.catalog.read('helper');
    expect(read?.hash).toBe(listing.definitionHash);
  });
});

describe('an agent whose references do not read', () => {
  it('is invalid when a document is missing, naming the path, and ready once it exists', async () => {
    const fixture = await start();
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[notes.md]' }));
    await fixture.catalog.refresh();
    const listing = entryOf(fixture);
    expect(listing.state).toBe('invalid');
    expect(listing.problem).toMatchObject({
      code: 'missing-reference',
      issues: [{ path: 'references.0' }],
    });
    expect(listing.problem?.message).toContain('notes.md');
    expect(fixture.catalog.find('helper')).toBeUndefined();

    // The file's bytes did not change: the rescan alone reads the document that now exists.
    await fixture.put('notes.md', 'Now here.\n');
    await fixture.catalog.refresh();
    expect(entryOf(fixture).state).toBe('ready');
    expect(fixture.catalog.find('helper')).toBeDefined();
  });

  it('is invalid when a document goes away, and keeps its revision when it returns unchanged', async () => {
    const fixture = await startWithDocuments();
    const before = entryOf(fixture).definitionRevision;
    await writeFile(join(fixture.directory, 'style.md'), '');
    await fixture.catalog.refresh();
    expect(entryOf(fixture).state).toBe('ready');
    await rm(join(fixture.directory, 'style.md'));
    await fixture.catalog.refresh();
    expect(entryOf(fixture)).toMatchObject({
      state: 'invalid',
      problem: { code: 'missing-reference' },
    });
    await fixture.put('style.md', 'Be brief.\n');
    await fixture.catalog.refresh();
    const after = entryOf(fixture);
    expect(after.state).toBe('ready');
    // Raised for the empty document and again for the restored one: each is its own content.
    expect(after.definitionRevision).toBe((before ?? 0) + 2);
  });

  it('is reported as changed when the problem moves to another path', async () => {
    const fixture = await start();
    await fixture.put('one.md', 'One.\n');
    await fixture.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, references: '[one.md, two.md]' }),
    );
    await fixture.catalog.refresh();
    expect(entryOf(fixture).problem?.message).toContain('two.md');
    const changed = fixture.nextChange((change) => change.changed.includes('helper'));
    await rm(join(fixture.directory, 'one.md'));
    await fixture.catalog.refresh();
    await changed;
    expect(entryOf(fixture).problem?.message).toContain('one.md');
  });

  it('is invalid when a document is over the size limit, or the documents add up to too much', async () => {
    const fixture = await start();
    await fixture.put('big.md', 'x'.repeat(AGENT_REFERENCE_SIZE_LIMIT + 1));
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[big.md]' }));
    await fixture.catalog.refresh();
    expect(entryOf(fixture).problem).toMatchObject({
      code: 'reference-too-large',
      issues: [{ path: 'references.0' }],
    });
    expect(entryOf(fixture).problem?.message).toContain('big.md');

    const each = AGENT_REFERENCE_SIZE_LIMIT;
    const count = Math.floor(AGENT_REFERENCES_TOTAL_SIZE_LIMIT / each) + 1;
    const names = Array.from({ length: count }, (_, index) => `part-${index}.md`);
    for (const name of names) await fixture.put(name, 'y'.repeat(each));
    await fixture.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, references: `[${names.join(', ')}]` }),
    );
    await fixture.catalog.refresh();
    expect(entryOf(fixture).problem).toMatchObject({ code: 'reference-too-large' });
    expect(entryOf(fixture).problem?.message).toContain(`part-${count - 1}.md`);
  });

  it('accepts a document exactly at the limit', async () => {
    const fixture = await start();
    await fixture.put('exact.md', 'z'.repeat(AGENT_REFERENCE_SIZE_LIMIT));
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[exact.md]' }));
    await fixture.catalog.refresh();
    expect(entryOf(fixture).state).toBe('ready');
  });

  it('is invalid when a document is not UTF-8 or is a directory', async () => {
    const fixture = await start();
    await fixture.put('binary.md', new Uint8Array([0xff, 0xfe, 0xfd]));
    await mkdir(join(fixture.directory, 'folder'));
    await fixture.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, references: '[binary.md]' }),
    );
    await fixture.catalog.refresh();
    expect(entryOf(fixture).problem).toMatchObject({ code: 'missing-reference' });
    expect(entryOf(fixture).problem?.message).toContain('UTF-8');
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[folder]' }));
    await fixture.catalog.refresh();
    expect(entryOf(fixture).problem).toMatchObject({ code: 'missing-reference' });
  });
});

describe('editing a reference document', () => {
  it('raises the revision with the file’s bytes unchanged, and records the digest on the version', async () => {
    const fixture = await startWithDocuments();
    const first = entryOf(fixture);
    const firstIdentity = bindingOf(fixture).hash;

    await fixture.put('style.md', 'Be thorough.\n');
    await fixture.catalog.refresh();

    const second = entryOf(fixture);
    expect(second.definitionHash).toBe(first.definitionHash);
    expect(second.definitionRevision).toBe((first.definitionRevision ?? 0) + 1);
    expect(bindingOf(fixture).hash).not.toBe(firstIdentity);
    expect(bindingOf(fixture).referenceDocuments?.[0]?.content).toBe('Be thorough.\n');

    const versions = await fixture.catalog.versions.list('helper');
    const [newest, previous] = versions;
    expect(newest?.revision).toBe(second.definitionRevision);
    expect(newest?.changedKeys).toEqual(['references']);
    expect(newest?.referenceDigests?.map((digest) => digest.path)).toEqual([
      'style.md',
      'docs/glossary.txt',
    ]);
    expect(newest?.referenceDigests?.[0]?.digest).not.toBe(previous?.referenceDigests?.[0]?.digest);
    expect(newest?.referenceDigests?.[1]?.digest).toBe(previous?.referenceDigests?.[1]?.digest);
    // A version holds digests, never a document's text.
    expect(JSON.stringify(newest)).not.toContain('Be thorough');
  });

  it('is not a change when a rescan finds the documents as they were', async () => {
    const fixture = await startWithDocuments();
    const before = entryOf(fixture).definitionRevision;
    await fixture.catalog.refresh();
    await fixture.catalog.refresh();
    expect(entryOf(fixture).definitionRevision).toBe(before);
    const versions = await fixture.catalog.versions.list('helper');
    expect(versions).toHaveLength(1);
  });

  it('is noticed by the catalog without a rescan being asked for, within the reference poll', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({ runtime, watch: true });
    await mkdir(join(fixture.directory, 'docs'));
    await fixture.put('style.md', 'Be brief.\n');
    await fixture.put('docs/glossary.txt', 'Order: a purchase.\n');
    await fixture.put('helper.md', WITH_REFERENCES);
    await fixture.catalog.refresh();
    const before = entryOf(fixture).definitionRevision;

    // A document in a subdirectory: `fs.watch` of the directory never sees it.
    await fixture.put('docs/glossary.txt', 'Order: a purchase or a return.\n');
    const changed = fixture.nextChange((change) => change.changed.includes('helper'));
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await changed;

    expect(entryOf(fixture).definitionRevision).toBe((before ?? 0) + 1);
    expect(bindingOf(fixture).referenceDocuments?.[1]?.content).toBe(
      'Order: a purchase or a return.\n',
    );
  });

  it('is noticed when the document goes missing, and the agent is listed invalid', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({ runtime, watch: true });
    await fixture.put('style.md', 'Be brief.\n');
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[style.md]' }));
    await fixture.catalog.refresh();
    expect(entryOf(fixture).state).toBe('ready');

    await rm(join(fixture.directory, 'style.md'));
    const changed = fixture.nextChange((change) => change.rejected.includes('helper'));
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
    await changed;
    expect(entryOf(fixture).problem?.code).toBe('missing-reference');
  });

  it('arms the poll only while an agent has references, and not after the catalog is closed', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({ runtime, watch: true });
    await fixture.put('plain.md', validAgentFile());
    await fixture.catalog.refresh();
    const withoutReferences = runtime.pendingTimers().length;

    await fixture.put('style.md', 'Be brief.\n');
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[style.md]' }));
    await fixture.catalog.refresh();
    expect(runtime.pendingTimers()).toHaveLength(withoutReferences + 1);

    await fixture.catalog.close();
    expect(runtime.pendingTimers()).toEqual([]);
    await rm(join(fixture.directory, 'style.md'));
    await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS * 3);
    expect(runtime.pendingTimers()).toEqual([]);
  });

  it('does not poll under a source that does not watch, and a scan still reads the documents', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({ runtime, watch: false });
    await fixture.put('style.md', 'Be brief.\n');
    await fixture.put('helper.md', agentFileText({ model: KNOWN_MODEL, references: '[style.md]' }));
    await fixture.catalog.refresh();
    expect(runtime.pendingTimers()).toEqual([]);
    await fixture.put('style.md', 'Be thorough.\n');
    await fixture.catalog.refresh();
    expect(bindingOf(fixture).referenceDocuments?.[0]?.content).toBe('Be thorough.\n');
  });

  it('reads no content for a document whose stamp has not moved, and reads it again once it has', async () => {
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const reads: string[] = [];
    const fixture = await start({
      runtime,
      watch: true,
      operations: {
        ...nodeAgentFileOperations,
        read: (path) => {
          reads.push(basename(path));
          return nodeAgentFileOperations.read(path);
        },
      },
    });
    await fixture.put('notes.txt', 'Be brief.\n');
    await fixture.put(
      'helper.md',
      agentFileText({ model: KNOWN_MODEL, references: '[notes.txt]' }),
    );
    await fixture.catalog.refresh();
    const initial = reads.filter((name) => name === 'notes.txt').length;
    expect(initial).toBeGreaterThan(0);

    // Many polls and rescans with the document as it was: nothing is read.
    for (let tick = 0; tick < 3; tick += 1) {
      await runtime.advance(DIRECTORY_POLL_INTERVAL_MILLISECONDS);
      await fixture.catalog.refresh();
    }
    expect(reads.filter((name) => name === 'notes.txt')).toHaveLength(initial);

    await fixture.put('notes.txt', 'Be thorough, and longer.\n');
    await fixture.catalog.refresh();
    expect(reads.filter((name) => name === 'notes.txt').length).toBeGreaterThan(initial);
    expect(bindingOf(fixture).referenceDocuments?.[0]?.content).toBe('Be thorough, and longer.\n');
  });

  it('polls at the interval the source states, not at a period of its own', async () => {
    const memory = createMemoryDefinitionSource('agent', {
      tools: {},
      referencePollMilliseconds: 30_000,
    });
    const runtime = createManualRuntimeServices({ origin: '2026-10-18T00:00:00.000Z' });
    const fixture = await start({ runtime, source: memory.source });
    memory.setSibling('style.md', 'Be brief.\n');
    memory.set('helper', agentFileText({ model: KNOWN_MODEL, references: '[style.md]' }));
    await fixture.catalog.refresh();
    expect(entryOf(fixture).state).toBe('ready');
    const [timer] = runtime.pendingTimers();
    // Nothing has advanced the manual clock, so a due time is the period.
    expect(timer?.dueAt).toBe(30_000);
    const reads = memory.siblingContentReads();

    // Nothing moved at the end of an interval: the document is looked at and not fetched.
    await runtime.advance(30_000);
    // The poll runs after the timer fires and arms the next one when it is done.
    await waitUntil(() => runtime.pendingTimers().length === 1);
    expect(memory.siblingContentReads()).toBe(reads);

    memory.setSibling('style.md', 'Be thorough.\n');
    await runtime.advance(29_999);
    expect(entryOf(fixture).definitionRevision).toBe(1);
    const changed = fixture.nextChange((change) => change.changed.includes('helper'));
    await runtime.advance(1);
    await changed;
    expect(entryOf(fixture).definitionRevision).toBe(2);
    expect(memory.siblingContentReads()).toBe(reads + 1);
  });

  it('is read afresh by detail, which does not describe a revision older than its documents', async () => {
    const fixture = await startWithDocuments();
    const before = entryOf(fixture).definitionRevision;
    await fixture.put('style.md', 'Be thorough.\n');
    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definitionRevision).toBe((before ?? 0) + 1);
    expect(detail?.definition?.references).toEqual(['style.md', 'docs/glossary.txt']);
  });
});

describe('writing an agent with references', () => {
  it('refuses a create whose document the source cannot read, and writes nothing', async () => {
    const fixture = await start();
    let thrown: unknown;
    try {
      await fixture.catalog.create('helper', {
        model: KNOWN_MODEL,
        references: ['missing.md'],
        instructions: 'Hi.\n',
      });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AgentFileError);
    expect(thrown).toMatchObject({ code: 'missing-reference' });
    expect(await fixture.catalog.read('helper')).toBeUndefined();
  });

  it('writes the list when the documents exist, and an update that leaves it out keeps it', async () => {
    const fixture = await start();
    await fixture.put('style.md', 'Be brief.\n');
    const created = await fixture.catalog.create('helper', {
      model: KNOWN_MODEL,
      references: ['style.md'],
      instructions: 'Hi.\n',
    });
    expect(entryOf(fixture).state).toBe('ready');
    const updated = await fixture.catalog.update(
      'helper',
      { model: KNOWN_MODEL, name: 'Renamed', instructions: 'Hi.\n' },
      { expectedHash: created.hash },
    );
    expect(updated.hash).not.toBe(created.hash);
    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definition?.references).toEqual(['style.md']);
  });

  it('refuses an update that would leave a reference unreadable', async () => {
    const fixture = await startWithDocuments();
    const current = await fixture.catalog.read('helper');
    let thrown: unknown;
    try {
      await fixture.catalog.update(
        'helper',
        { model: KNOWN_MODEL, references: ['style.md', 'nowhere.txt'], instructions: 'Hi.\n' },
        { expectedHash: current?.hash ?? '' },
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({ code: 'missing-reference' });
    const after = await fixture.catalog.read('helper');
    expect(after?.hash).toBe(current?.hash);
  });
});

describe('restoring a version of an agent with references', () => {
  it('writes the version’s list of paths back, and leaves the documents as the paths name them now', async () => {
    const fixture = await start();
    await fixture.put('one.md', 'First.\n');
    await fixture.put('two.md', 'Second.\n');
    const created = await fixture.catalog.create('helper', {
      model: KNOWN_MODEL,
      references: ['one.md'],
      instructions: 'Hi.\n',
    });
    const updated = await fixture.catalog.update(
      'helper',
      { model: KNOWN_MODEL, references: ['two.md'], instructions: 'Hi.\n' },
      { expectedHash: created.hash },
    );
    const [, first] = await fixture.catalog.versions.list('helper');
    expect(first?.definition.references).toEqual(['one.md']);

    await fixture.put('one.md', 'First, edited.\n');
    const restored = await fixture.catalog.versions.restore('helper', first?.revision ?? 0, {
      expectedHash: updated.hash,
    });
    expect(restored.hash).not.toBe(updated.hash);
    // The restored file reads back as version 1's definition. Its bytes need not be version 1's: a
    // rewrite keeps the file's own layout and `create` wrote its own.
    const restoredFile = await fixture.catalog.read('helper');
    const reread = parseAgentFile('helper', restoredFile?.text ?? '');
    if (!reread.ok)
      throw new Error(`Expected the restored file to parse: ${reread.problem.message}`);
    expect(reread.file.definition).toMatchObject({
      model: first?.definition.model,
      references: ['one.md'],
      instructions: first?.definition.instructions,
    });
    const detail = await fixture.catalog.detail('helper');
    expect(detail?.definition?.references).toEqual(['one.md']);
    expect(bindingOf(fixture).referenceDocuments?.[0]?.content).toBe('First, edited.\n');
    // The restored revision is a new one, whose digest is of the document as it is now.
    const [newest] = await fixture.catalog.versions.list('helper');
    expect(newest?.revision).toBe((first?.revision ?? 0) + 2);
    expect(newest?.referenceDigests?.[0]?.digest).not.toBe(first?.referenceDigests?.[0]?.digest);
  });
});

describe('the run’s snapshot', () => {
  it('keeps the text of the documents, under a key of its own for each set of documents', async () => {
    const fixture = await startWithDocuments();
    const snapshots = createAgentSnapshotStore({
      store: textValueStore(new MemoryStorage()),
      nowISO: () => '2026-10-18T00:00:00.000Z',
    });
    const firstBinding = bindingOf(fixture);
    await snapshots.recordRun(firstBinding, 'run-1');

    await fixture.put('style.md', 'Be thorough.\n');
    await fixture.catalog.refresh();
    const secondBinding = bindingOf(fixture);
    await snapshots.recordRun(secondBinding, 'run-2');

    expect(secondBinding.hash).not.toBe(firstBinding.hash);
    // The run that began on the first documents resumes on them.
    const first = await snapshots.load('helper', firstBinding.hash);
    expect(first?.referenceDocuments?.[0]?.content).toBe('Be brief.\n');
    const second = await snapshots.load('helper', secondBinding.hash);
    expect(second?.referenceDocuments?.[0]?.content).toBe('Be thorough.\n');

    if (first === undefined) throw new Error('Expected the first snapshot.');
    const rebuilt = fixture.catalog.agentFromSnapshot(first, 1);
    expect(readFileAgentBinding(rebuilt)?.referenceDocuments?.[0]?.content).toBe('Be brief.\n');
    expect(readFileAgentBinding(rebuilt)?.hash).toBe(firstBinding.hash);
  });

  it('reads a snapshot written before references existed', async () => {
    const store = textValueStore(new MemoryStorage());
    const snapshots = createAgentSnapshotStore({ store, nowISO: () => '2026-10-18T00:00:00.000Z' });
    const fixture = await start();
    await fixture.put('plain.md', validAgentFile());
    await fixture.catalog.refresh();
    const agent = fixture.catalog.find('plain');
    const binding = agent === undefined ? undefined : readFileAgentBinding(agent);
    if (binding === undefined) throw new Error('Expected the plain agent.');
    await snapshots.recordRun(binding, 'run-1');
    const loaded = await snapshots.load('plain', binding.hash);
    expect(loaded?.referenceDocuments).toBeUndefined();
  });
});

describe('the instructions a run is given', () => {
  const documents: AgentReferenceDocument[] = [
    { path: 'style.md', content: 'Be brief.\n\n', digest: 'a'.repeat(64) },
    { path: 'docs/glossary.txt', content: 'Order: a purchase.', digest: 'b'.repeat(64) },
  ];

  it('follow the file’s instructions with each document under a heading naming its path', () => {
    expect(renderInstructions('You are helpful.', documents)).toBe(
      'You are helpful.\n\n# Reference documents\n\n## Reference: style.md\n\nBe brief.\n\n## Reference: docs/glossary.txt\n\nOrder: a purchase.',
    );
  });

  it('are the documents alone when the file has no instructions, and unchanged without documents', () => {
    expect(renderInstructions('  \n', documents)).toStartWith('# Reference documents');
    expect(renderInstructions('You are helpful.', [])).toBe('You are helpful.');
  });
});

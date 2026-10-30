/**
 * COR-1866 — `compaction` and `references` over `bureau.agents.definitions.*`: a create writes
 * them, `get` shows them (`null` for a file that sets none), an update that leaves them out keeps
 * the file's values and `null` removes them, an out-of-range value is refused before anything is
 * written, and a document the Bureau cannot read or a summarizer it lacks is `Unprocessable`.
 * The versions carry the digest of each document, never its text.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'bun:test';

import {
  callAs,
  DEFINITION,
  disposeServed,
  listOf,
  ownerPath,
  serve,
  type Served,
} from './agent-definitions-fixtures.test-support.ts';

afterEach(disposeServed);

async function withSummarizer(served: Served): Promise<void> {
  const { revision } = await served.bureau.settings.get();
  const applied = await served.bureau.settings.update(
    { 'context.summarizerModel': 'anthropic/claude-opus-5' },
    { expectedRevision: revision },
  );
  expect(applied.outcome).toBe('applied');
}

describe('compaction and references on the definition operations', () => {
  it('creates an agent with both, and shows them on get', async () => {
    const served = await serve();
    await withSummarizer(served);
    await writeFile(join(served.directory, 'style.md'), 'Be brief.\n');
    const compaction = { enabled: true, thresholdPercent: 70 };
    const created = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'patient',
      definition: { ...DEFINITION, compaction, references: ['style.md'] },
    });
    expect(created.error).toBeUndefined();

    const text = await readFile(ownerPath(served, 'patient'), 'utf8');
    expect(text).toContain('thresholdPercent: 70');
    expect(text).toContain('style.md');
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'patient' });
    expect(got.result?.['definition']).toMatchObject({ compaction, references: ['style.md'] });
    expect(got.result?.['state']).toBe('ready');
  });

  it('shows null for a file that sets neither', async () => {
    const served = await serve();
    await served.put('plain.md', `---\nmodel: ${DEFINITION.model}\n---\nBody.\n`);
    await served.bureau.agents.refresh();
    const got = await callAs(served.owner, 'bureau.agents.definitions.get', { id: 'plain' });
    expect(got.result?.['definition']).toMatchObject({ compaction: null, references: null });
  });

  it('keeps both when an update leaves them out, and removes them for null', async () => {
    const served = await serve();
    await withSummarizer(served);
    await served.put('style.md', 'Be brief.\n');
    await served.put(
      'patient.md',
      `---\nmodel: ${DEFINITION.model}\ncompaction: {enabled: true}\nreferences: [style.md]\n---\nBody.\n`,
    );
    await served.bureau.agents.refresh();
    const kept = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: served.hashOf('patient'),
      definition: { model: DEFINITION.model, name: 'Patient', instructions: 'Body.\n' },
    });
    expect(kept.error).toBeUndefined();
    const afterKeep = await callAs(served.owner, 'bureau.agents.definitions.get', {
      id: 'patient',
    });
    expect(afterKeep.result?.['definition']).toMatchObject({
      name: 'Patient',
      compaction: { enabled: true },
      references: ['style.md'],
    });

    const cleared = await callAs(served.owner, 'bureau.agents.definitions.update', {
      id: 'patient',
      expectedHash: kept.result?.['hash'],
      definition: {
        model: DEFINITION.model,
        name: 'Patient',
        instructions: 'Body.\n',
        compaction: null,
        references: null,
      },
    });
    expect(cleared.error).toBeUndefined();
    const text = await readFile(ownerPath(served, 'patient'), 'utf8');
    expect(text).not.toContain('compaction');
    expect(text).not.toContain('references');
  });

  it('refuses an out-of-range or malformed value and writes nothing', async () => {
    const served = await serve();
    for (const definition of [
      { ...DEFINITION, compaction: { enabled: true, thresholdPercent: 49 } },
      { ...DEFINITION, compaction: { enabled: true, thresholdPercent: 96 } },
      { ...DEFINITION, compaction: { thresholdPercent: 70 } },
      { ...DEFINITION, compaction: { enabled: true, model: 'x' } },
      { ...DEFINITION, references: ['../outside.md'] },
      { ...DEFINITION, references: ['/etc/passwd'] },
      { ...DEFINITION, references: ['a.md', 'a.md'] },
      { ...DEFINITION, references: ['.env'] },
    ]) {
      const response = await callAs(served.owner, 'bureau.agents.definitions.create', {
        id: 'strict',
        definition,
      });
      expect([JSON.stringify(definition), response.error?.data?.httpStatus]).toEqual([
        JSON.stringify(definition),
        400,
      ]);
    }
    expect(await Bun.file(ownerPath(served, 'strict')).exists()).toBe(false);
  });

  it('is Unprocessable for a document it cannot read, and for compaction with no summarizer', async () => {
    const served = await serve();
    const missing = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'lost',
      definition: { ...DEFINITION, references: ['nowhere.md'] },
    });
    expect(missing.error?.data?.httpStatus).toBe(422);
    expect(missing.error?.data).toMatchObject({ reason: 'missing-reference' });
    expect(missing.error?.message).toContain('nowhere.md');

    const noSummarizer = await callAs(served.owner, 'bureau.agents.definitions.create', {
      id: 'lost',
      definition: { ...DEFINITION, compaction: { enabled: true } },
    });
    expect(noSummarizer.error?.data?.httpStatus).toBe(422);
    expect(noSummarizer.error?.data).toMatchObject({ reason: 'invalid-frontmatter' });
    expect(await Bun.file(ownerPath(served, 'lost')).exists()).toBe(false);
  });

  it('lists an agent with a missing document as invalid, naming the path', async () => {
    const served = await serve();
    await served.put(
      'lost.md',
      `---\nmodel: ${DEFINITION.model}\nreferences: [gone.md]\n---\nBody.\n`,
    );
    await served.bureau.agents.refresh();
    const listed = await callAs(served.owner, 'bureau.agents.definitions.list', {});
    const lost = listOf(listed, 'agents').find((entry) => entry['id'] === 'lost');
    expect(lost).toMatchObject({
      state: 'invalid',
      problem: { code: 'missing-reference', issues: [{ path: 'references.0' }] },
    });
  });
});

describe('the versions of an agent with references', () => {
  it('carry each document’s digest and name the key an edit to a document changes', async () => {
    const served = await serve();
    await served.put('style.md', 'Be brief.\n');
    await served.put(
      'patient.md',
      `---\nmodel: ${DEFINITION.model}\nreferences: [style.md]\n---\nBody.\n`,
    );
    await served.bureau.agents.refresh();
    await served.put('style.md', 'Be thorough.\n');
    await served.bureau.agents.refresh();

    const response = await callAs(served.owner, 'bureau.agents.versions.list', { id: 'patient' });
    const versions = listOf(response, 'versions');
    expect(versions.map((entry) => entry['revision'])).toEqual([2, 1]);
    expect(versions[0]?.['changedKeys']).toEqual(['references']);
    const digests = (index: number) =>
      versions[index]?.['referenceDigests'] as Array<{ path: string; digest: string }>;
    expect(digests(0)[0]?.path).toBe('style.md');
    expect(digests(0)[0]?.digest).not.toBe(digests(1)[0]?.digest);
    expect(JSON.stringify(response)).not.toContain('Be thorough');
  });

  it('show null digests for an agent with no references', async () => {
    const served = await serve();
    await served.put('plain.md', `---\nmodel: ${DEFINITION.model}\n---\nBody.\n`);
    await served.bureau.agents.refresh();
    const response = await callAs(served.owner, 'bureau.agents.versions.list', { id: 'plain' });
    expect(listOf(response, 'versions')[0]?.['referenceDigests']).toBeNull();
  });
});

describe('a run of an agent with references', () => {
  it('is given the documents after the file’s instructions', async () => {
    const served = await serve();
    await served.put('style.md', 'Be brief.\n');
    await served.put(
      'patient.md',
      `---\nmodel: ${DEFINITION.model}\nreferences: [style.md]\n---\nYou are patient.\n`,
    );
    await served.bureau.agents.refresh();
    const run = await served.bureau.tasks.start('patient', 'hello');
    await run.result();
    const prompt = served.observed.at(-1)?.systemPrompt;
    expect(prompt).toBe(
      'You are patient.\n\n# Reference documents\n\n## Reference: style.md\n\nBe brief.',
    );
  });
});

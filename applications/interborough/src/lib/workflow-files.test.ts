/**
 * The browser's view of the Bureau's workflow files: the operations `bureau.workflows.*`, parsed
 * at the boundary, and the text of a file turned into what an update sends.
 */
import { rejectionOf } from '@lostgradient/testing';
import { HttpClientError } from '@lostgradient/weft';
import { afterEach, describe, expect, test } from 'bun:test';

import {
  deleteWorkflowFile,
  getWorkflowFile,
  listWorkflowFiles,
  listWorkflowRevisions,
  parseWorkflowText,
  pauseWorkflowFile,
  resumeWorkflowFile,
  signalWorkflows,
  updateDefinitionFromText,
  updateWorkflowFile,
} from './workflow-files.ts';
import {
  DOCUMENT_TEXT,
  emptyWorld,
  installWorkflowWorld,
  readyFile,
  workflowFaults,
  type WorkflowStub,
} from './workflow-world.test-support.ts';

let stub: WorkflowStub | undefined;
afterEach(() => {
  stub?.restore();
  stub = undefined;
});

describe('parseWorkflowText', () => {
  test('reads a file’s trigger and steps, and its agent and paused flag', () => {
    const parsed = parseWorkflowText(DOCUMENT_TEXT);
    expect(parsed?.trigger).toEqual({ kind: 'schedule', spec: '0 6 * * *' });
    expect(parsed?.steps.map((step) => step.kind)).toEqual(['activity', 'await-signal']);
    expect(parsed?.agent).toBe('writer');
  });

  test('is undefined for text that is not a workflow document, or no text at all', () => {
    expect(parseWorkflowText(null)).toBeUndefined();
    expect(parseWorkflowText('{ not json')).toBeUndefined();
    expect(parseWorkflowText('[]')).toBeUndefined();
    expect(parseWorkflowText('{"trigger": 1, "steps": []}')).toBeUndefined();
    expect(parseWorkflowText('{"trigger": {"kind": "x"}}')).toBeUndefined();
  });
});

describe('updateDefinitionFromText', () => {
  test('strips the name, because the update schema rejects keys it does not know', () => {
    const result = updateDefinitionFromText(DOCUMENT_TEXT);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition).not.toHaveProperty('name');
    expect(result.definition).toMatchObject({ agent: 'writer', trigger: { kind: 'schedule' } });
    expect(Array.isArray(result.definition['steps'])).toBe(true);
  });

  test('keeps every other key as it was written, so the Bureau can refuse one it does not know', () => {
    const result = updateDefinitionFromText(
      JSON.stringify({ name: 'x', trigger: { kind: 'signal', name: 'go' }, steps: [], extra: 1 }),
    );
    expect(result.ok && result.definition).toEqual({
      trigger: { kind: 'signal', name: 'go' },
      steps: [],
      extra: 1,
    });
  });

  test('says why text that is not JSON, or not an object, cannot be saved', () => {
    expect(updateDefinitionFromText('{ nope')).toEqual({ ok: false, reason: 'not-json' });
    expect(updateDefinitionFromText('')).toEqual({ ok: false, reason: 'not-json' });
    expect(updateDefinitionFromText('[1]')).toEqual({ ok: false, reason: 'not-object' });
    expect(updateDefinitionFromText('"text"')).toEqual({ ok: false, reason: 'not-object' });
  });
});

describe('the operations', () => {
  test('list follows the pages to the end, and get parses the file with its text and schedule', async () => {
    stub = installWorkflowWorld(
      emptyWorld({ files: [readyFile('one'), readyFile('two', { agent: null })] }),
    );
    const listed = await listWorkflowFiles();
    expect(listed.map((file) => file.id)).toEqual(['one', 'two']);
    const detail = await getWorkflowFile('one');
    expect(detail.text).toContain('"one"');
    expect(detail.schedule?.status).toBe('active');
    expect(stub.callsTo('bureau.workflows.get')[0]?.params).toEqual({ id: 'one' });
  });

  test('revisions lists the versions that ran, with the document each ran', async () => {
    stub = installWorkflowWorld(
      emptyWorld({
        files: [readyFile('one')],
        revisions: {
          one: [
            {
              workflowVersion: 'v1',
              firstRunAt: '2026-10-19T08:00:00.000Z',
              lastRunAt: '2026-10-19T09:00:00.000Z',
              document: { name: 'one', trigger: { kind: 'schedule' }, steps: [] },
            },
          ],
        },
      }),
    );
    const revisions = await listWorkflowRevisions('one');
    expect(revisions.map((revision) => revision.workflowVersion)).toEqual(['v1']);
  });

  test('every write names the hash it read, and answers the hash now on disk', async () => {
    stub = installWorkflowWorld(emptyWorld({ files: [readyFile('one')] }));
    const paused = await pauseWorkflowFile('one', 'hash-1');
    expect(paused.id).toBe('one');
    expect(paused.hash).not.toBe('hash-1');
    expect(stub.callsTo('bureau.workflows.pause')[0]?.params).toEqual({
      id: 'one',
      expectedHash: 'hash-1',
    });
    const resumed = await resumeWorkflowFile('one', paused.hash);
    expect(resumed.hash).not.toBe(paused.hash);
    const updated = await updateWorkflowFile('one', resumed.hash, {
      trigger: { kind: 'schedule', spec: '1h' },
      steps: [],
    });
    expect(stub.callsTo('bureau.workflows.update')[0]?.params).toMatchObject({
      id: 'one',
      expectedHash: resumed.hash,
      definition: { trigger: { kind: 'schedule', spec: '1h' }, steps: [] },
    });
    await deleteWorkflowFile('one', updated.hash);
    expect(stub.file('one')).toBeUndefined();
  });

  test('an update that still carries the name is refused, as the Bureau does', async () => {
    stub = installWorkflowWorld(emptyWorld({ files: [readyFile('one')] }));
    const refused = await rejectionOf(
      updateWorkflowFile('one', 'hash-1', { name: 'one', trigger: { kind: 'x' }, steps: [] }),
    );
    expect(refused).toBeInstanceOf(HttpClientError);
    expect(stub.file('one')?.hash).toBe('hash-1');
  });

  test('a stale hash is refused and changes nothing', async () => {
    stub = installWorkflowWorld(emptyWorld({ files: [readyFile('one')] }));
    expect(await rejectionOf(pauseWorkflowFile('one', 'old'))).toBeInstanceOf(HttpClientError);
    expect(stub.file('one')?.paused).toBe(false);
    expect(workflowFaults.stale('x').weftCode).toBe('StaleRevision');
  });

  test('signal sends a name and a payload, and answers who was started and who was reached', async () => {
    stub = installWorkflowWorld(emptyWorld());
    stub.world.signalAnswer = { started: ['run-1'], delivered: ['run-2', 'run-3'] };
    const answer = await signalWorkflows({ name: 'approve', payload: { ok: true } });
    expect(answer).toEqual({ started: ['run-1'], delivered: ['run-2', 'run-3'] });
    expect(stub.callsTo('bureau.workflows.signal')[0]?.params).toEqual({
      name: 'approve',
      payload: { ok: true },
    });
    await signalWorkflows({ name: 'no-payload' });
    expect(stub.callsTo('bureau.workflows.signal')[1]?.params).toEqual({ name: 'no-payload' });
  });
});

import { rejectionOf } from '@lostgradient/testing/promise-outcome';
import { HttpClientError } from '@lostgradient/weft';
import { describe, expect, test } from 'bun:test';

import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
import type { WorkflowDefinitionInput } from '../../lib/workflow-files.ts';
import {
  DUPLICATE_ATTEMPTS,
  duplicateDefinition,
  duplicateIdentifier,
  DuplicateRefused,
  duplicateWorkflowFile,
} from './workflow-duplicate.ts';

const TEXT = JSON.stringify({
  name: 'release-notes',
  title: 'Release notes',
  trigger: { kind: 'schedule', spec: '0 11 * * 5' },
  steps: [{ kind: 'await-signal', signal: 'notes-approved' }],
});

const taken = () =>
  new HttpClientError(409, 'taken', {
    faultCode: 'Conflict',
    data: { reason: 'workflow-file-exists' },
  });

describe('the identifier of a copy', () => {
  test('is the original with -copy after it, then a number', () => {
    expect(duplicateIdentifier('release-notes', 1)).toBe('release-notes-copy');
    expect(duplicateIdentifier('release-notes', 2)).toBe('release-notes-copy-2');
  });

  test('fits the Bureau’s 64 characters by cutting the original, never the suffix', () => {
    const long = `a${'-b'.repeat(40)}`;
    const copy = duplicateIdentifier(long, 3);
    expect(copy.length).toBeLessThanOrEqual(64);
    expect(copy.endsWith('-copy-3')).toBe(true);
    expect(copy).not.toContain('--');
  });
});

describe('the definition of a copy', () => {
  test('is the document without its name, paused, and titled as a copy', () => {
    expect(duplicateDefinition(TEXT, 'Release notes')).toEqual({
      title: WORKFLOW_COPY.page.menu.copyTitle('Release notes'),
      trigger: { kind: 'schedule', spec: '0 11 * * 5' },
      steps: [{ kind: 'await-signal', signal: 'notes-approved' }],
      paused: true,
    });
  });

  test('keeps a document with no title untitled', () => {
    const definition = duplicateDefinition(
      JSON.stringify({ name: 'x', trigger: { kind: 'manual' }, steps: [] }),
      null,
    );
    expect(definition).toEqual({ trigger: { kind: 'manual' }, steps: [], paused: true });
  });

  test('is nothing for text that is not a document', () => {
    expect(duplicateDefinition('{ not json', null)).toBeUndefined();
  });
});

describe('writing a copy', () => {
  test('takes the next identifier while the Bureau answers that one is taken', async () => {
    const tried: string[] = [];
    const write = async (id: string, _definition: WorkflowDefinitionInput) => {
      tried.push(id);
      if (tried.length < 3) throw taken();
      return { id, hash: 'hash-new' };
    };
    const result = await duplicateWorkflowFile('release-notes', TEXT, 'Release notes', write);
    expect(result).toEqual({ id: 'release-notes-copy-3', hash: 'hash-new' });
    expect(tried).toEqual(['release-notes-copy', 'release-notes-copy-2', 'release-notes-copy-3']);
  });

  test('says every name is taken once it has tried them all', async () => {
    const tried: string[] = [];
    const write = async (id: string): Promise<never> => {
      tried.push(id);
      throw taken();
    };
    expect(
      await rejectionOf(duplicateWorkflowFile('release-notes', TEXT, null, write)),
    ).toBeInstanceOf(DuplicateRefused);
    expect(tried).toHaveLength(DUPLICATE_ATTEMPTS);
  });

  test('throws any other refusal as it came, and tries nothing more', async () => {
    const refusal = new HttpClientError(422, 'not a workflow', { faultCode: 'Unprocessable' });
    const tried: string[] = [];
    const write = async (id: string): Promise<never> => {
      tried.push(id);
      throw refusal;
    };
    expect(await rejectionOf(duplicateWorkflowFile('release-notes', TEXT, null, write))).toBe(
      refusal,
    );
    expect(tried).toEqual(['release-notes-copy']);
  });
});

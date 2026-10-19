/**
 * COR-1527 — the workflow file format: one JSON file is COR-1525's document plus `agent` and
 * `paused`, named by its identifier, and anything else makes it invalid.
 */
import { workflowDocumentVersion } from '@lostgradient/weft';
import { describe, expect, it } from 'bun:test';

import { createWorkflowDocumentHost } from './workflow-host';
import {
  checkWorkflowIdentifier,
  parseWorkflowFile,
  serializeWorkflowFile,
  workflowVersionOf,
} from './workflow-file';

const host = createWorkflowDocumentHost({
  runAgentStep: async () => ({ content: '', output: null, finishReason: 'stop-condition' }),
});

function file(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    name: 'digest',
    trigger: { kind: 'schedule', spec: '1s' },
    steps: [
      { kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Write it' } },
    ],
    ...overrides,
  });
}

function problemOf(id: string, text: string) {
  const parsed = parseWorkflowFile(id, text, host);
  if (parsed.ok) throw new Error('expected a problem');
  return parsed.problem;
}

describe('workflow identifiers', () => {
  it('accepts a lowercase letter first, then letters, digits, and inner hyphens', () => {
    for (const id of ['a', 'digest', 'nightly-digest-2', 'a1']) {
      expect(checkWorkflowIdentifier(id)).toBeUndefined();
    }
  });

  it('rejects a digit first, a trailing or leading hyphen, capitals, dots, and slashes', () => {
    for (const id of ['1digest', '-digest', 'digest-', 'Digest', 'a.b', 'a/b', '', 'a_b']) {
      expect(checkWorkflowIdentifier(id)?.code).toBe('invalid-identifier');
    }
  });

  it('accepts 64 characters and rejects 65', () => {
    expect(checkWorkflowIdentifier('a'.repeat(64))).toBeUndefined();
    expect(checkWorkflowIdentifier('a'.repeat(65))?.code).toBe('invalid-identifier');
  });
});

describe('parsing a workflow file', () => {
  it('strips agent and paused before handing the document to Weft', () => {
    const parsed = parseWorkflowFile('digest', file({ agent: 'writer', paused: true }), host);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    expect(parsed.file.agent).toBe('writer');
    expect(parsed.file.paused).toBe(true);
    expect(Object.keys(parsed.file.document).toSorted()).toEqual(['name', 'steps', 'trigger']);
  });

  it('defaults agent to null and paused to false', () => {
    const parsed = parseWorkflowFile('digest', file(), host);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    expect(parsed.file.agent).toBeNull();
    expect(parsed.file.paused).toBe(false);
  });

  it('does not check agent against any catalog', () => {
    expect(parseWorkflowFile('digest', file({ agent: 'no-such-agent' }), host).ok).toBe(true);
  });

  it('computes the same version Weft computes, from the document without agent and paused', async () => {
    const parsed = parseWorkflowFile('digest', file({ agent: 'writer', paused: true }), host);
    if (!parsed.ok) throw new Error(parsed.problem.message);
    expect(workflowVersionOf(parsed.file.document)).toBe(
      await workflowDocumentVersion(parsed.file.document),
    );
    const plain = parseWorkflowFile('digest', file(), host);
    if (!plain.ok) throw new Error(plain.problem.message);
    expect(workflowVersionOf(plain.file.document)).toBe(workflowVersionOf(parsed.file.document));
  });

  it('is invalid-document when the name differs from the identifier', () => {
    expect(problemOf('digest', file({ name: 'other' })).code).toBe('invalid-document');
  });

  it('is invalid-document for an unknown key, because Weft’s document schema is strict', () => {
    const problem = problemOf('digest', file({ owner: 'someone' }));
    expect(problem.code).toBe('invalid-document');
    expect(problem.issues?.length).toBeGreaterThan(0);
  });

  it('is invalid-document for a badly typed agent or paused', () => {
    for (const overrides of [
      { agent: 3 },
      { agent: null },
      { agent: 'Not An Identifier' },
      { paused: 'yes' },
      { paused: null },
    ]) {
      expect(problemOf('digest', file(overrides)).code).toBe('invalid-document');
    }
  });

  it('is invalid-document for a trigger kind other than schedule', () => {
    const problem = problemOf('digest', file({ trigger: { kind: 'signal', name: 'go' } }));
    expect(problem.code).toBe('invalid-document');
    expect(problem.issues?.[0]?.path).toBe('trigger.kind');
  });

  it('is invalid-document for an extra trigger field and a malformed spec', () => {
    expect(
      problemOf('digest', file({ trigger: { kind: 'schedule', spec: '1s', extra: 1 } })).code,
    ).toBe('invalid-document');
    for (const spec of ['not a cron', '', 3, '61 * * * *']) {
      expect(problemOf('digest', file({ trigger: { kind: 'schedule', spec } })).code).toBe(
        'invalid-document',
      );
    }
  });

  it('accepts a cron expression, a duration shorthand, and each overlap policy', () => {
    for (const spec of ['*/5 * * * *', '1s', '6 hours', '*/2 * * * * *']) {
      expect(
        parseWorkflowFile('digest', file({ trigger: { kind: 'schedule', spec } }), host).ok,
      ).toBe(true);
    }
    for (const overlap of ['skip', 'queue', 'cancel-running', 'allow']) {
      const trigger = { kind: 'schedule', spec: '1s', overlap };
      expect(parseWorkflowFile('digest', file({ trigger }), host).ok).toBe(true);
    }
    const trigger = { kind: 'schedule', spec: '1s', overlap: 'sometimes' };
    expect(problemOf('digest', file({ trigger })).code).toBe('invalid-document');
  });

  it('is invalid-document for an agent step whose input is not exactly agent and message', () => {
    const step = (input: unknown) => ({ kind: 'activity', handler: 'agent', input });
    for (const input of [
      undefined,
      null,
      'text',
      { agent: 'writer' },
      { message: 'hi' },
      { agent: 'writer', message: 3 },
      { agent: 'Bad Name', message: 'hi' },
      { agent: 'writer', message: 'hi', extra: true },
    ]) {
      const problem = problemOf('digest', file({ steps: [step(input)] }));
      expect(problem.code).toBe('invalid-document');
      expect(problem.issues?.[0]?.path).toBe('steps[0].input');
    }
  });

  it('is invalid-document for an unregistered activity handler', () => {
    const steps = [{ kind: 'activity', handler: 'send-email' }];
    expect(problemOf('digest', file({ steps })).code).toBe('invalid-document');
  });

  it('is invalid-json for text that is not JSON or not an object', () => {
    expect(problemOf('digest', '{').code).toBe('invalid-json');
    expect(problemOf('digest', '[]').code).toBe('invalid-json');
    expect(problemOf('digest', 'null').code).toBe('invalid-json');
  });

  it('is invalid-identifier before it looks at the contents', () => {
    expect(problemOf('Bad_Name', file()).code).toBe('invalid-identifier');
  });
});

describe('serializing a workflow file', () => {
  it('writes name, agent, paused, trigger, and steps as two-space JSON with a trailing newline', () => {
    const text = serializeWorkflowFile('digest', {
      agent: 'writer',
      paused: true,
      trigger: { kind: 'schedule', spec: '1s' },
      steps: [{ kind: 'sleep', duration: 1 }],
    });
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual(['name', 'agent', 'paused', 'trigger', 'steps']);
    expect(JSON.parse(text).name).toBe('digest');
    const parsed = parseWorkflowFile('digest', text, host);
    expect(parsed.ok).toBe(true);
  });

  it('leaves agent and paused out when they were not given', () => {
    const text = serializeWorkflowFile('digest', {
      trigger: { kind: 'schedule', spec: '1s' },
      steps: [{ kind: 'sleep', duration: 1 }],
    });
    expect(Object.keys(JSON.parse(text))).toEqual(['name', 'trigger', 'steps']);
  });
});

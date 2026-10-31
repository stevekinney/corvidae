/**
 * COR-1527 — the host a workflow file runs on: the exact text an agent step sends, the frozen
 * handler map, and the refusal to register on an engine bound to another host.
 */
import { Engine, type DocumentWorkflowHost } from '@lostgradient/weft';
import { MemoryStorage } from '@lostgradient/storage';
import { describe, expect, it } from 'bun:test';

import {
  bindWorkflowHost,
  composeAgentMessage,
  createWorkflowDocumentHost,
  registerBureauWorkflowDocuments,
  WorkflowHostConflictError,
  type AgentStepRequest,
} from './workflow-host';

const FENCE = '```';

describe('composeAgentMessage', () => {
  it('is the message unchanged when there is no trigger and no previous result', () => {
    expect(composeAgentMessage('Write the digest', undefined, undefined)).toBe('Write the digest');
    expect(composeAgentMessage('Write the digest', null, null)).toBe('Write the digest');
  });

  it('appends the trigger as a labelled fenced JSON block after a blank line', () => {
    expect(composeAgentMessage('Go', { kind: 'schedule', scheduleId: 's1' }, null)).toBe(
      `Go\n\nTrigger:\n${FENCE}json\n{\n  "kind": "schedule",\n  "scheduleId": "s1"\n}\n${FENCE}`,
    );
  });

  it('appends the previous step’s result when it is present and not null', () => {
    expect(composeAgentMessage('Go', undefined, { content: 'hi', output: null })).toBe(
      `Go\n\nPrevious step:\n${FENCE}json\n{\n  "content": "hi",\n  "output": null\n}\n${FENCE}`,
    );
    expect(composeAgentMessage('Go', null, 'text')).toBe(
      `Go\n\nPrevious step:\n${FENCE}json\n"text"\n${FENCE}`,
    );
  });

  it('appends the trigger and then the previous step, each after its own blank line', () => {
    expect(composeAgentMessage('Go', 1, [2])).toBe(
      `Go\n\nTrigger:\n${FENCE}json\n1\n${FENCE}\n\nPrevious step:\n${FENCE}json\n[\n  2\n]\n${FENCE}`,
    );
  });

  it('keeps a falsy value that is not null: zero, false, and the empty string', () => {
    expect(composeAgentMessage('Go', 0, false)).toContain('Trigger:\n```json\n0\n```');
    expect(composeAgentMessage('Go', 0, false)).toContain('Previous step:\n```json\nfalse\n```');
    expect(composeAgentMessage('Go', '', undefined)).toContain('Trigger:\n```json\n""\n```');
  });

  it('uses a longer fence when the JSON holds a run of backticks, so the block cannot close early', () => {
    const composed = composeAgentMessage('Go', { text: 'a ```` b' }, null);
    expect(composed.startsWith('Go\n\nTrigger:\n`````json\n')).toBe(true);
    expect(composed.endsWith('\n`````')).toBe(true);
  });
});

describe('the workflow host', () => {
  it('is frozen, with the agent activity and the schedule and signal trigger kinds', () => {
    const host = createWorkflowDocumentHost({ runAgentStep: async () => unreachable() });
    expect(Object.isFrozen(host)).toBe(true);
    expect(Object.isFrozen(host.activities)).toBe(true);
    expect(Object.isFrozen(host.triggerKinds)).toBe(true);
    expect(Object.keys(host.activities)).toEqual(['agent']);
    expect(Object.keys(host.triggerKinds)).toEqual(['schedule', 'signal']);
  });

  it('hands the agent step the composed message and the instance and step it runs as', async () => {
    const requests: AgentStepRequest[] = [];
    const host = createWorkflowDocumentHost({
      runAgentStep: async (request) => {
        requests.push(request);
        return { content: 'done', output: null, finishReason: 'stop-condition' };
      },
    });
    const agent = host.activities['agent'];
    if (typeof agent !== 'function') throw new Error('the agent activity is a bare handler');
    const result = await agent({
      input: { agent: 'writer', message: 'Write it' },
      trigger: 7,
      previous: null,
      workflowId: 'run-1',
      step: 2,
    });
    expect(result).toEqual({ content: 'done', output: null, finishReason: 'stop-condition' });
    expect(requests).toEqual([
      {
        agent: 'writer',
        message: `Write it\n\nTrigger:\n${FENCE}json\n7\n${FENCE}`,
        workflowId: 'run-1',
        step: 2,
      },
    ]);
  });
});

describe('binding an engine to a host', () => {
  it('accepts the same host again and refuses a different one with a typed error naming both', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const first = createWorkflowDocumentHost({ runAgentStep: async () => unreachable() });
    const second: DocumentWorkflowHost = {
      activities: { agent: () => null, extra: () => null },
      triggerKinds: { schedule: () => undefined },
    };
    bindWorkflowHost(engine, first);
    bindWorkflowHost(engine, first);
    let caught: unknown;
    try {
      bindWorkflowHost(engine, second);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowHostConflictError);
    expect((caught as WorkflowHostConflictError).code).toBe('workflow-host-conflict');
    expect((caught as Error).message).toContain('activities [agent]');
    expect((caught as Error).message).toContain('activities [agent, extra]');
  });
});

describe('registering documents through the host', () => {
  const document = {
    name: 'digest',
    trigger: { kind: 'schedule', spec: '1h' },
    steps: [{ kind: 'activity', handler: 'agent', input: { agent: 'writer', message: 'Hi' } }],
  };

  it('registers on an engine, and refuses a different host on that engine with a typed error that names the conflict', async () => {
    await using engine = new Engine({ storage: new MemoryStorage(), backgroundTasks: 'manual' });
    const first = createWorkflowDocumentHost({ runAgentStep: async () => unreachable() });
    const registered = await registerBureauWorkflowDocuments(engine, first, { active: [document] });
    expect(registered.map((entry) => entry.name)).toEqual(['digest']);
    // The same host registers again.
    await registerBureauWorkflowDocuments(engine, first, { active: [document] });

    const other = createWorkflowDocumentHost({ runAgentStep: async () => unreachable() });
    let caught: unknown;
    try {
      await registerBureauWorkflowDocuments(engine, other, { active: [document] });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkflowHostConflictError);
    expect((caught as Error).message).toContain('different host');
  });
});

function unreachable(): never {
  throw new Error('not reached');
}

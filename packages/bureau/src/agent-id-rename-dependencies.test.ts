import { describe, expect, it } from 'bun:test';

import { renameHookScope, renameWorkflowAgent } from './agent-id-rename-dependencies.ts';

describe('saved-agent identifier dependency transforms', () => {
  it('rewrites only workflow ownership and executable agent activity inputs', () => {
    const changed = renameWorkflowAgent(
      {
        agent: 'old-id',
        trigger: { kind: 'manual' },
        steps: [
          { kind: 'activity', handler: 'agent', input: { agent: 'old-id', message: 'Run it' } },
          { kind: 'activity', handler: 'other', input: { agent: 'old-id' } },
          { kind: 'await-signal', signal: 'old-id' },
        ],
      },
      'old-id',
      'new-id',
    );

    expect(changed.agent).toBe('new-id');
    expect(changed.steps[0]).toMatchObject({ input: { agent: 'new-id' } });
    expect(changed.steps[1]).toMatchObject({ input: { agent: 'old-id' } });
    expect(changed.steps[2]).toMatchObject({ signal: 'old-id' });
  });

  it('rewrites agent hook scope without changing another scope', () => {
    expect(renameHookScope({ kind: 'agent', id: 'old-id' }, 'old-id', 'new-id')).toEqual({
      kind: 'agent',
      id: 'new-id',
    });
    expect(renameHookScope({ kind: 'workflow', id: 'old-id' }, 'old-id', 'new-id')).toEqual({
      kind: 'workflow',
      id: 'old-id',
    });
  });
});

/** What a run's page calls a workflow type: the recorded name for a built-in one, else words. */
import { describe, expect, test } from 'bun:test';

import { RUN_DETAIL_COPY } from '../app/copy.ts';
import { builtInWorkflowName, workflowTypeName } from './workflow-type-name.ts';

describe('workflowTypeName', () => {
  test('names the three built-in types as the design records them', () => {
    expect(workflowTypeName('agentRun')).toBe('Chat with an agent');
    expect(workflowTypeName('goalRun')).toBe('Work on a goal');
    expect(workflowTypeName('durableHeartbeatTick')).toBe('Agent heartbeat');
    expect(workflowTypeName('agentRun')).toBe(RUN_DETAIL_COPY.workflowNames.agentRun);
  });

  test('reads any other type as its identifier in words, never as a title-cased "Agent Run"', () => {
    expect(workflowTypeName('release-notes')).toBe('Release notes');
    expect(workflowTypeName('orderFulfillment')).toBe('Order fulfillment');
  });

  test('knows a built-in type only by an own key, so an inherited name is not one', () => {
    expect(builtInWorkflowName('agentRun')).toBe('Chat with an agent');
    expect(builtInWorkflowName('release-notes')).toBeUndefined();
    expect(builtInWorkflowName('toString')).toBeUndefined();
    expect(builtInWorkflowName('constructor')).toBeUndefined();
  });
});

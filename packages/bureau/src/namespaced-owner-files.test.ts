/**
 * COR-1871 — an owner's file stem keeps today's bare pattern, so a file named for a plugin's
 * `plugin:name` is listed invalid and never runs.
 */
import { afterEach, describe, expect, it } from 'bun:test';

import {
  type AgentFileFixture,
  createAgentFileFixture,
  validAgentFile,
} from './testing/agent-file-fixtures.test-support';
import {
  createWorkflowFileFixture,
  type WorkflowFileFixture,
  workflowFileText,
} from './testing/workflow-file-fixtures.test-support';

const agentFixtures: AgentFileFixture[] = [];
const workflowFixtures: WorkflowFileFixture[] = [];

afterEach(async () => {
  for (const fixture of agentFixtures.splice(0)) await fixture.dispose();
  for (const fixture of workflowFixtures.splice(0)) await fixture.dispose();
});

describe('an owner file named for a plugin identifier', () => {
  it('is listed invalid for an agent', async () => {
    const fixture = await createAgentFileFixture({ watch: false });
    agentFixtures.push(fixture);
    await fixture.put('linear:triager.md', validAgentFile());
    await fixture.catalog.refresh();

    expect(fixture.catalog.find('linear:triager')).toBeUndefined();
    expect(fixture.catalog.list().find((entry) => entry.id === 'linear:triager')).toMatchObject({
      state: 'invalid',
      problem: { code: 'invalid-identifier' },
    });
  });

  it('is listed invalid for a workflow', async () => {
    const fixture = await createWorkflowFileFixture({ watch: false });
    workflowFixtures.push(fixture);
    await fixture.put('linear:triager.json', workflowFileText('linear:triager'));
    await fixture.catalog.refresh();

    expect(fixture.catalog.find('linear:triager')).toBeUndefined();
    expect(fixture.catalog.list().find((entry) => entry.id === 'linear:triager')).toMatchObject({
      state: 'invalid',
      problem: { code: 'invalid-identifier' },
    });
  });
});

/**
 * COR-1628 — a call to a tool the active skills' `allowed-tools` exclude is refused, and the
 * refusal reaches an AG-UI client as the call's `TOOL_CALL_RESULT`.
 */
import { EventType } from '@ag-ui/core';
import { type Toolbox } from '@lostgradient/operative';
import { createTool, createToolbox } from 'armorer';
import { afterAll, describe, expect, it } from 'bun:test';
import { z } from 'zod';

import { removeSkillRoots, skillCatalogOnDisk } from '../skill-policy-fixtures.test-support.ts';
import { openHarness, runAgentInput, startRequest } from './ag-ui-fixtures.test-support.ts';
import { readAgUiStream } from './ag-ui-stream.test-support.ts';

afterAll(removeSkillRoots);

const REFUSAL = `Tool "ping" is not available: the active skills' allowed-tools exclude it.`;

const respond = (toolCalls: Array<{ id: string; name: string; arguments: unknown }>) => ({
  kind: 'respond' as const,
  response: { content: '', toolCalls },
});

describe('the AG-UI stream of a run narrowed by an active skill (COR-1628)', () => {
  it('carries the refusal as the TOOL_CALL_RESULT of the refused call', async () => {
    const catalog = await skillCatalogOnDisk();
    const executions: string[] = [];
    const toolbox = createToolbox([
      createTool({
        name: 'ping',
        version: '1.0.0',
        description: 'Pings',
        input: z.object({}),
        async execute() {
          executions.push('ping');
          return 'pong';
        },
      }),
    ]) as unknown as Toolbox;
    const harness = await openHarness({
      script: [
        respond([{ id: 'lock-1', name: 'activate_skill', arguments: { name: 'lock' } }]),
        respond([{ id: 'ping-1', name: 'ping', arguments: {} }]),
        { kind: 'respond', response: { content: 'Done.', toolCalls: [] } },
      ],
      toolbox,
      skills: { catalog: await catalog.discover() },
    });
    try {
      const frames = await readAgUiStream(await harness.handler(startRequest(runAgentInput())));

      const results = frames
        .map((frame) => frame.event)
        .filter((event) => event.type === EventType.TOOL_CALL_RESULT);
      expect(results).toContainEqual(
        expect.objectContaining({
          toolCallId: 'ping-1',
          content: expect.stringContaining(REFUSAL),
        }),
      );
      expect(executions).toEqual([]);
    } finally {
      await harness.dispose();
    }
  });
});

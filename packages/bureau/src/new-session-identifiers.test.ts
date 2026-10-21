/**
 * COR-1590 — `.` and `..` may not name a session that does not exist yet. A browser resolves them
 * out of the address a client would open the session at, so a session created under one could
 * never be opened again. `createRun` and `createSchedule` refuse them as `BAD_REQUEST` with a
 * message beginning `unopenable-session-identifier:`; the AG-UI mount refuses a start that would
 * create one as `INVALID_INPUT` (`http/ag-ui-mount-routes.test.ts`).
 */
import { createMockGenerate, stopWhen } from '@lostgradient/operative';
import { createToolbox } from 'armorer';
import { afterEach, describe, expect, it } from 'bun:test';

import { BureauError, createBureau } from './create-bureau';
import {
  createCheckValidator,
  createDiagnostics,
  hangUntilAborted,
  workerAgent,
} from './testing/goal-fixtures.test-support';
import type { Bureau } from './types';

const open: Bureau[] = [];

afterEach(async () => {
  for (const bureau of open.splice(0)) await bureau.dispose();
});

async function boot() {
  const bureau = await createBureau({
    agents: { worker: workerAgent(hangUntilAborted) },
    validators: [createCheckValidator()],
    generate: createMockGenerate([{ content: 'ok', toolCalls: [] }]),
    toolbox: createToolbox([]),
    stopWhen: stopWhen.noToolCalls(),
    storage: { type: 'memory' },
    durableExecution: true,
    onDiagnostic: createDiagnostics().onDiagnostic,
  });
  const typed = bureau as unknown as Bureau;
  open.push(typed);
  return typed;
}

const UNOPENABLE = ['.', '..'];

describe('a session id a browser would resolve away', () => {
  it.each(UNOPENABLE)('may not be the new session %s of createRun', async (sessionId) => {
    const bureau = await boot();

    const error = await bureau.createRun({ message: 'hello', sessionId }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('unopenable-session-identifier');
    expect(await bureau.getSession(sessionId)).toBeUndefined();
  });

  it.each(UNOPENABLE)('may not be the new session %s of a schedule', async (sessionId) => {
    const bureau = await boot();

    const error = await bureau
      .createSchedule({ agentName: 'worker', input: 'x', spec: '1h', sessionId })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BureauError);
    expect(error).toMatchObject({ code: 'BAD_REQUEST' });
    expect((error as Error).message).toContain('unopenable-session-identifier');
  });

  it('is still free when it only contains dots', async () => {
    const bureau = await boot();

    const run = await bureau.createRun({ message: 'hello', sessionId: '...' });

    expect(run.sessionId).toBe('...');
  });
});

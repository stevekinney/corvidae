import { principalFromApiKey } from '@lostgradient/backchannel';
import { createOperationRegistry } from '@lostgradient/backchannel/internals';
import { MemoryStorage } from '@lostgradient/storage';
import { Engine } from '../../core/engine.ts';
import { type WorkflowContext, workflow } from '../../core/types.ts';
import { listSchedulesOperation, listSchedulesRestBinding } from './list-schedules.ts';

const echoWorkflow = workflow({ name: 'echo' }).execute(async function* (
  _ctx: WorkflowContext,
  input: unknown,
) {
  return input;
});

export function createListSchedulesTestEngine(): Engine {
  const engine = new Engine({ storage: new MemoryStorage() });
  engine.register(echoWorkflow);
  return engine;
}

export function createListSchedulesApiKeyAuthContext() {
  return {
    authContext: {
      method: 'api-key' as const,
      principal: principalFromApiKey({ subject: 'test', scopes: ['schedules:read'] }),
    },
  };
}

export const listSchedulesTestRegistry = createOperationRegistry([listSchedulesOperation]);
export const listSchedulesTestRestBindings = [listSchedulesRestBinding];

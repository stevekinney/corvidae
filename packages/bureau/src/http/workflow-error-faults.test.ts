/**
 * Pins the fault a default `createBureauHandler` answers when an operation's host throws one of
 * the three workflow error classes (COR-2473): Bureau uses Weft's classification, so the fault
 * must not change when the classification moves behind the host.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';

import {
  WorkflowAlreadyExistsError,
  WorkflowNotFoundError,
  WorkflowNotRegisteredError,
} from '@lostgradient/weft';

import { buildBureau } from './bureau-handler-fixtures.test-support.ts';
import { createBureauHandler } from './create-bureau-handler.ts';

type Bureau = Awaited<ReturnType<typeof buildBureau>>;
let bureau: Bureau;

beforeEach(async () => {
  bureau = await buildBureau();
});

afterEach(async () => {
  await bureau.dispose();
});

/** The Bureau whose settings read throws `thrown`. */
function settingsThrowing(thrown: Error): Bureau {
  return new Proxy(bureau, {
    get(target, property) {
      if (property === 'settings') {
        return {
          ...target.settings,
          get: async () => {
            throw thrown;
          },
        };
      }
      return Reflect.get(target, property);
    },
  });
}

/** The JSON-RPC error `bureau.settings.get` answers when reading the settings throws `thrown`. */
async function errorOf(thrown: Error): Promise<unknown> {
  const handler = createBureauHandler(settingsThrowing(thrown), {
    unauthenticatedAccess: 'allow',
  });
  return settingsError(handler);
}

async function settingsError(handler: (request: Request) => Promise<Response>): Promise<unknown> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'bureau.settings.get', params: {} }),
    }),
  );
  return ((await response.json()) as { error: unknown }).error;
}

describe('an undeclared fault behind a default createBureauHandler', () => {
  const undeclared = {
    code: 'Timeout',
    message: 'too slow',
    data: { operationName: 'bureau.settings.get' },
  };
  const originalNodeEnvironment = Bun.env['NODE_ENV'];
  const originalStrictFaults = Bun.env['WEFT_STRICT_FAULTS'];

  afterEach(() => {
    if (originalNodeEnvironment === undefined) delete Bun.env['NODE_ENV'];
    else Bun.env['NODE_ENV'] = originalNodeEnvironment;
    if (originalStrictFaults === undefined) delete Bun.env['WEFT_STRICT_FAULTS'];
    else Bun.env['WEFT_STRICT_FAULTS'] = originalStrictFaults;
  });

  it('follows the environment between two calls on one handler', async () => {
    // `bureau.settings.get` declares `Forbidden` only, so a thrown `Timeout` is undeclared.
    const source = settingsThrowing(undeclared as unknown as Error);
    const handler = createBureauHandler(source, { unauthenticatedAccess: 'allow' });
    const warn = spyOn(console, 'warn').mockImplementation(() => undefined);
    try {
      Bun.env['NODE_ENV'] = 'production';
      delete Bun.env['WEFT_STRICT_FAULTS'];
      const production = await settingsError(handler);
      Bun.env['NODE_ENV'] = 'test';
      const test = await settingsError(handler);

      expect(production).toMatchObject({ data: { weftCode: 'Timeout' }, message: 'too slow' });
      expect(test).toMatchObject({ data: { weftCode: 'EngineFailure' } });
    } finally {
      warn.mockRestore();
    }
  });
});

describe('workflow errors thrown behind a default createBureauHandler', () => {
  it('WorkflowAlreadyExistsError answers Conflict', async () => {
    expect(await errorOf(new WorkflowAlreadyExistsError('wf-1'))).toEqual({
      code: -32021,
      data: {
        httpStatus: 409,
        reason: 'resource already exists',
        retryable: false,
        weftCode: 'Conflict',
      },
      message: 'conflict',
    });
  });

  it('WorkflowNotRegisteredError answers InvalidParams', async () => {
    const error = new WorkflowNotRegisteredError('missing-type');
    expect(await errorOf(error)).toEqual({
      code: -32602,
      data: { httpStatus: 400, issues: [], retryable: false, weftCode: 'InvalidParams' },
      message: error.message,
    });
  });

  it('WorkflowNotFoundError answers NotFound', async () => {
    expect(await errorOf(new WorkflowNotFoundError('wf-1'))).toEqual({
      code: -32020,
      data: { httpStatus: 404, resource: 'workflow', retryable: false, weftCode: 'NotFound' },
      message: 'not found',
    });
  });
});

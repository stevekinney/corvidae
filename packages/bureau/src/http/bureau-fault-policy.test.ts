/**
 * COR-2518: one policy maps every `BureauError` to its fault, with remediation, and no operation
 * under `http` maps one of its own outside it.
 */
import {
  createOperationHandler,
  createOperationHandlerAuthenticator,
  defineOperation,
  isFaultCode,
  type OperationFault,
  principalFromApiKey,
} from '@lostgradient/backchannel';
import { WEFT_SCOPE_VOCABULARY } from '@lostgradient/weft';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import {
  BUREAU_ERROR_CODES,
  BureauError,
  type BureauErrorCode,
  BureauShuttingDownError,
} from '../bureau-errors.ts';
import type { PendingReview } from '../bureau-types/reviews.ts';
import {
  type BureauFaultContext,
  bureauFaultOf,
  bureauFaultPolicy,
  bureauRefusalKind,
} from './bureau-fault-policy.ts';
import {
  type BureauReviewsOperationHost,
  bureauReviewsOperations,
} from './bureau-reviews-operations.ts';
import { BUREAU_SCOPES } from './bureau-scopes.ts';
import { mayAccessOwnedResource } from './owner-predicate.ts';
import {
  type BureauTasksRespondOperationHost,
  tasksRespondOperation,
} from './management/tasks-respond-operation.ts';
import {
  workflowsRunsCancelOperation,
  workflowsRunsRetryOperation,
} from './management/workflows-operations.ts';
import {
  answering,
  openBureau,
  OWNER,
  rpc,
  type RpcBody,
} from './management/management-fixtures.test-support.ts';
import { waitForTaskState } from '../test';
import { startTaskFrom } from '../test/task-start-request.ts';

/** An error of `code`, with the subject `NOT_CONFIGURED` requires. */
function errorOf(code: BureauErrorCode): BureauError {
  return code === 'NOT_CONFIGURED'
    ? new BureauError(`${code} message`, code, 'generate')
    : new BureauError(`${code} message`, code);
}

/** The refusal a Bureau that has closed admission gives. */
function closingBureau(): BureauShuttingDownError {
  return new BureauShuttingDownError('The Bureau is shutting down.', '2026-11-20T00:00:00.000Z');
}

/**
 * The fault the policy makes of `error`, which is a BureauError: as an operation that refines it
 * in `context` builds it, or as the policy classifies it when there is none.
 */
function faultOf(error: BureauError, context?: BureauFaultContext): OperationFault {
  const fault =
    context === undefined
      ? bureauFaultPolicy.classifyError?.(error)
      : bureauFaultOf(error, context);
  expect(fault, `a fault for ${error.code}`).toBeDefined();
  return fault as OperationFault;
}

const MAX_REMEDIATION_LENGTH = 500;

/** What the wire accepts of a remediation: one line of 1 to 500 characters, no control characters. */
function remediationProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  if (Array.from(value).length > MAX_REMEDIATION_LENGTH) return 'too long';
  if (/\p{Cc}/u.test(value)) return 'control character';
  return undefined;
}

describe('the Bureau fault policy', () => {
  it('maps every BureauError code to a fault code that is not EngineFailure', () => {
    for (const code of BUREAU_ERROR_CODES) {
      const fault = faultOf(errorOf(code));
      expect(isFaultCode(fault.code), code).toBe(true);
      expect(fault.code, code).not.toBe('EngineFailure');
    }
  });

  it('gives every code a remediation the wire accepts, and puts it on every fault it builds', () => {
    for (const code of BUREAU_ERROR_CODES) {
      const { remediation } = faultOf(errorOf(code));
      expect(remediationProblem(remediation), code).toBeUndefined();
      for (const form of ['unprocessable', 'shutting-down'] as const) {
        const fault = faultOf(errorOf(code), { forms: { [code]: form } });
        expect(fault.remediation, `${code} ${form}`).toBe(remediation);
      }
    }
  });

  it('names the resource, the field and the capability an operation passes in', () => {
    expect(
      faultOf(errorOf('NOT_FOUND'), { notFound: { resource: 'run', identifier: 'r1' } }),
    ).toMatchObject({
      code: 'NotFound',
      message: 'No run with id "r1"',
      data: { resource: 'run', identifier: 'r1' },
    });
    expect(faultOf(errorOf('BAD_REQUEST'), { invalidPath: ['input', 'payload'] })).toMatchObject({
      code: 'InvalidParams',
      data: { issues: [{ path: ['input', 'payload'], message: 'BAD_REQUEST message' }] },
    });
    expect(faultOf(errorOf('NOT_CONFIGURED'))).toMatchObject({
      data: { capability: 'generate' },
    });
    expect(faultOf(errorOf('NOT_CONFIGURED'), { capability: 'durable' })).toMatchObject({
      data: { capability: 'durable' },
    });
    expect(faultOf(errorOf('CONFLICT'), { forms: { CONFLICT: 'shutting-down' } })).toMatchObject({
      code: 'Unavailable',
      data: { reason: 'shutting-down' },
    });
  });

  it('does not repeat a storage outage message, which could name an internal', () => {
    const fault = faultOf(
      new BureauError('connect ECONNREFUSED 10.0.0.7:5432', 'STORAGE_UNAVAILABLE'),
    );
    expect(fault.message).not.toContain('10.0.0.7');
    expect(fault.code).toBe('Unavailable');
  });

  it('leaves what is not a BureauError as it was', () => {
    const other = new Error('boom');
    expect(bureauFaultOf(other, { invalidPath: ['x'] })).toBe(other);
    expect(bureauFaultOf('text')).toBe('text');
    expect(bureauRefusalKind(other)).toBeUndefined();
    expect(bureauRefusalKind(errorOf('NOT_FOUND'))).toEqual({
      kind: 'not-found',
      message: 'NOT_FOUND message',
    });
    expect(bureauRefusalKind(errorOf('BAD_REQUEST'))?.kind).toBe('bad-request');
    expect(bureauRefusalKind(errorOf('CONFLICT'))).toBeUndefined();
  });

  it('builds a fault only for a code the operation refines, and leaves the rest to the policy', () => {
    const conflict = errorOf('CONFLICT');
    // Nothing is said about `CONFLICT`, so it comes back for the policy to classify.
    expect(
      bureauFaultOf(conflict, {
        invalidPath: ['x'],
        notFound: { resource: 'run', identifier: 'r' },
      }),
    ).toBe(conflict);
    expect(bureauFaultOf(conflict)).toBe(conflict);
    const storage = errorOf('STORAGE_UNAVAILABLE');
    expect(bureauFaultOf(storage, { forms: { CONFLICT: 'shutting-down' } })).toBe(storage);
    expect(bureauFaultOf(conflict, { forms: { CONFLICT: 'shutting-down' } })).not.toBe(conflict);
  });

  it('answers a closing Bureau as Unavailable with the reason shutting-down, whatever the operation says', () => {
    const closing = closingBureau();
    expect(faultOf(closing)).toMatchObject({
      code: 'Unavailable',
      data: { reason: 'shutting-down' },
    });
    expect(faultOf(closing, { forms: { CONFLICT: 'unprocessable' } })).toMatchObject({
      code: 'Unprocessable',
    });
    expect(faultOf(closing).remediation).toEqual(expect.any(String));
  });

  it('hands a BureauError to the policy and everything else to Weft', () => {
    expect(bureauFaultPolicy.classifyError?.(errorOf('CONFLICT'))).toMatchObject({
      code: 'Conflict',
    });
    expect(bureauFaultPolicy.classifyError?.(new Error('boom'))).toBeUndefined();
    expect(bureauFaultPolicy.isKnownErrorCode?.('WorkflowNotFoundError')).toBe(true);
    expect(typeof bureauFaultPolicy.strict).toBe('function');
  });
});

describe('an operation that maps nothing of its own', () => {
  const throwing = (code: BureauErrorCode, index: number) =>
    defineOperation({
      name: `test.raise.code${index}`,
      authorize: async () => ({ allowed: true as const }),
      mcpExposable: false,
      summary: 'Raises a BureauError',
      description: 'Raises a BureauError of one code, to see which fault the pipeline answers.',
      destructive: false,
      tags: ['Test'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      producibleFaults: [],
      access: { kind: 'authenticated' },
      discoverable: false,
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => {
        throw errorOf(code);
      },
    });

  it('answers the mapped fault for each code, never EngineFailure, through the pipeline', async () => {
    const operations = BUREAU_ERROR_CODES.map(throwing);
    const handler = createOperationHandler({
      operations,
      host: {},
      authenticate: async () => ({
        method: 'api-key' as const,
        principal: principalFromApiKey({ subject: 'tester', scopes: [] }),
      }),
      faultPolicy: bureauFaultPolicy,
    });
    for (const [index, code] of BUREAU_ERROR_CODES.entries()) {
      const response = await handler(
        new Request('http://localhost/jsonrpc', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: index,
            method: operations[index]!.name,
            params: {},
          }),
        }),
      );
      const body = (await response.json()) as RpcBody;
      const expected = faultOf(errorOf(code));
      expect(body.error?.message, code).toBe(expected.message);
      expect(body.error?.data?.['remediation'], code).toBe(expected.remediation);
      expect(body.error?.data?.['retryable'], code).toBeDefined();
      expect(body.error?.message, code).not.toBe('internal error');
    }
  });

  it('is served by the Bureau handler with the policy, whichever operation raised the error', async () => {
    const agent = createAgent({ name: 'agent', generate: answering() });
    const opened = await openBureau({ agents: { agent } });
    try {
      const run = await startTaskFrom(opened.bureau, {
        agentName: 'agent',
        input: 'q',
        principal: OWNER.alice,
      });
      await waitForTaskState(opened.bureau, run.id);
      // `bureau.contexts.rename` maps `BAD_REQUEST` and a shutdown of its own, and nothing for a
      // storage outage: that one is the policy's.
      const rename = spyOn(opened.bureau.contexts, 'rename').mockRejectedValue(
        new BureauError('connect ECONNREFUSED 10.0.0.7:5432', 'STORAGE_UNAVAILABLE'),
      );
      const body = await rpc(
        opened.handler,
        'bureau.contexts.rename',
        { contextId: run.contextId, title: 'x' },
        'alice-key',
      );
      rename.mockRestore();

      expect(body.error?.data?.['remediation']).toBe(
        faultOf(new BureauError('x', 'STORAGE_UNAVAILABLE')).remediation,
      );
      expect(body.error?.data?.['remediation']).toEqual(expect.any(String));
      expect(body.error?.message).not.toContain('10.0.0.7');
      expect(body.error?.code).not.toBe(-32603);
    } finally {
      await opened.dispose();
    }
  });
});

const API_KEY = 'policy-test-key';
const authentication = {
  resolveApiKeyPrincipal: async (key: string) =>
    key === API_KEY
      ? principalFromApiKey({ subject: 'tester', scopes: ['bureau.workflows:write'] })
      : null,
  auditSink: () => undefined,
};

/** The faults an operation answers in strict mode, where an undeclared one becomes `EngineFailure`. */
const strictBureauFaultPolicy = { ...bureauFaultPolicy, strict: true };

async function callJsonRpc(
  handler: (request: Request) => Promise<Response>,
  method: string,
  params: unknown,
): Promise<RpcBody> {
  const response = await handler(
    new Request('http://localhost/jsonrpc', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    }),
  );
  return (await response.json()) as RpcBody;
}

/** The real operations, served by the real pipeline with a host whose Bureau raises `error`. */
function servedRaising(error: Error): readonly {
  readonly operation: string;
  readonly handler: (request: Request) => Promise<Response>;
  readonly params: unknown;
}[] {
  const authenticate = createOperationHandlerAuthenticator(authentication, {
    scopeVocabulary: WEFT_SCOPE_VOCABULARY,
    additionalScopes: BUREAU_SCOPES,
  });
  const ownership = {
    runOwner: async () => 'api-key:tester',
    mayAccess: mayAccessOwnedResource,
  };
  const review = {
    kind: 'human-wait',
    id: 'human-wait:run-1:ask:0',
    runId: 'run-1',
    sessionId: 'session-1',
    signalName: 'ask',
    requestedAt: 0,
    ageMilliseconds: 0,
    status: 'pending',
  } as PendingReview;
  const reviewsHost: BureauReviewsOperationHost = {
    reviewContinuation: async () => ({ status: 'not-chat' }),
    reviews: {
      list: () => [review],
      get: async () => review,
      resolve: async () => {
        throw error;
      },
    },
    ownership,
  };
  const tasksHost: BureauTasksRespondOperationHost = {
    ownership,
    tasks: { get: async () => undefined, ownerOf: async () => 'api-key:tester' },
    respond: async () => {
      throw error;
    },
  } as never;
  const workflowsHost = {
    ownership,
    codeWorkflow: () => undefined,
    workflows: {
      cancel: async () => {
        throw error;
      },
      retryRun: async () => {
        throw error;
      },
    },
  } as never;
  const faultPolicy = strictBureauFaultPolicy;
  return [
    {
      operation: 'bureau.reviews.resolve',
      handler: createOperationHandler({
        operations: bureauReviewsOperations,
        host: reviewsHost,
        authenticate,
        faultPolicy,
      }),
      params: { id: review.id, decision: 'approve' },
    },
    {
      operation: 'bureau.tasks.respond',
      handler: createOperationHandler({
        operations: [tasksRespondOperation],
        host: tasksHost,
        authenticate,
        faultPolicy,
      }),
      params: { taskId: 'task-1', messageId: 'message-1', answer: 'yes' },
    },
    {
      operation: 'bureau.workflows.runs.cancel',
      handler: createOperationHandler({
        operations: [workflowsRunsCancelOperation],
        host: workflowsHost,
        authenticate,
        faultPolicy,
      }),
      params: { runId: 'run-1' },
    },
    {
      operation: 'bureau.workflows.runs.retry',
      handler: createOperationHandler({
        operations: [workflowsRunsRetryOperation],
        host: workflowsHost,
        authenticate,
        faultPolicy,
      }),
      params: { runId: 'run-1', step: 1 },
    },
  ];
}

describe('the real operations, in strict mode', () => {
  it('answer every BureauError code with its mapped fault, never EngineFailure or an undeclared fault', async () => {
    for (const code of BUREAU_ERROR_CODES) {
      for (const { operation, handler, params } of servedRaising(errorOf(code))) {
        const body = await callJsonRpc(handler, operation, params);
        const label = `${operation} ${code}`;
        expect(body.error, label).toBeDefined();
        // `EngineFailure` and the strict-mode answer to an undeclared fault both read `internal error`
        // or name the declaration, and neither carries a remediation.
        expect(body.error?.message, label).not.toBe('internal error');
        expect(body.error?.message, label).not.toContain('undeclared fault');
        expect(body.error?.data?.['remediation'], label).toEqual(expect.any(String));
      }
    }
  });

  it('answer a closing Bureau as Unavailable with the reason shutting-down, unless they declare Conflict for it', async () => {
    // `bureau.reviews.resolve` and `bureau.tasks.respond` answer a `CONFLICT` themselves, and
    // declare no `Unavailable`: they keep the `Conflict` they always gave. A pass-through is the
    // policy's, which is `Unavailable`.
    const declaresConflict = new Set(['bureau.reviews.resolve', 'bureau.tasks.respond']);
    for (const { operation, handler, params } of servedRaising(closingBureau())) {
      const body = await callJsonRpc(handler, operation, params);
      if (declaresConflict.has(operation)) {
        expect(body.error?.data?.['httpStatus'], operation).toBe(409);
        continue;
      }
      expect(body.error?.data?.['httpStatus'], operation).toBe(503);
      expect(body.error?.data?.['reason'], operation).toBe('shutting-down');
    }
  });

  it('catches an operation that throws a fault it does not declare', async () => {
    // The control: an operation that declares nothing and throws a ready-made `Unavailable` is what
    // the strict pipeline turns into `EngineFailure`, which the assertions above would read.
    const operation = defineOperation({
      name: 'test.raise.undeclared',
      authorize: async () => ({ allowed: true as const }),
      mcpExposable: false,
      summary: 'Throws an undeclared fault',
      description: 'Throws a fault its declaration does not list.',
      destructive: false,
      tags: ['Test'],
      inputSchema: z.object({}),
      outputSchema: z.object({}),
      producibleFaults: [],
      access: { kind: 'authenticated' },
      discoverable: false,
      transports: { http: false, jsonRpcHttp: true, jsonRpcWebSocket: false, jsonRpcStdio: false },
      unknownKeyPolicy: { http: 'reject', jsonRpc: 'reject' },
      invoke: async () => {
        throw { code: 'Unavailable', message: 'storage', data: {} } satisfies OperationFault;
      },
    });
    const handler = createOperationHandler({
      operations: [operation],
      host: {},
      authenticate: async () => ({
        method: 'api-key' as const,
        principal: principalFromApiKey({ subject: 'tester', scopes: [] }),
      }),
      faultPolicy: strictBureauFaultPolicy,
    });
    const body = await callJsonRpc(handler, 'test.raise.undeclared', {});
    expect(body.error?.message).toContain('undeclared fault');
  });
});

describe('a BureauError message the Weft fallback used to read', () => {
  // Weft's message fallback turned a pass-through message containing "not found", "already
  // exists" or "timeout" into `NotFound`, `Conflict` or `Timeout`. No Bureau error is raised with
  // such a literal message under another code, so the code decides the same fault either way.
  it('never carries a code other than the one the fallback would have chosen', async () => {
    const sourceDirectory = join(dirname(fileURLToPath(import.meta.url)), '..');
    const constructed =
      /(?:new BureauError|createBureauError|createError)\(\s*([`'"])((?:(?!\1)[\s\S])*?)\1\s*,\s*'([A-Z_]+)'/g;
    const phrases: readonly (readonly [RegExp, string])[] = [
      [/not found/i, 'NOT_FOUND'],
      [/already exists/i, 'CONFLICT'],
    ];
    let checked = 0;
    for await (const path of new Glob('**/*.ts').scan({ cwd: sourceDirectory, absolute: true })) {
      if (/\.test(-support)?\.ts$/.test(path)) continue;
      const text = await readFile(path, 'utf8');
      for (const match of text.matchAll(constructed)) {
        const [, , message = '', code = ''] = match;
        expect(/time ?out|timed out/i.test(message), `${path}: ${message}`).toBe(false);
        for (const [phrase, expectedCode] of phrases) {
          if (!phrase.test(message)) continue;
          checked += 1;
          expect(code, `${relative(sourceDirectory, path)}: ${message}`).toBe(expectedCode);
        }
      }
    }
    expect(checked).toBeGreaterThan(10);
  });
});

/** A call that tests a BureauError's class, or a code of its own, to build a fault. */
const FORBIDDEN_PATTERNS: readonly { readonly name: string; readonly pattern: RegExp }[] = [
  { name: 'instanceof BureauError', pattern: /instanceof\s+BureauError\b/ },
  {
    name: 'a comparison of a code',
    pattern:
      /\.code\s*[!=]==?\s*['"](?:NOT_FOUND|CONFLICT|NOT_CONFIGURED|BAD_REQUEST|RATE_LIMITED|UNSUPPORTED_CAPABILITY|STORAGE_UNAVAILABLE)['"]/,
  },
  {
    name: 'a case of a code',
    pattern:
      /case\s+['"](?:NOT_FOUND|CONFLICT|NOT_CONFIGURED|BAD_REQUEST|RATE_LIMITED|UNSUPPORTED_CAPABILITY|STORAGE_UNAVAILABLE)['"]\s*:/,
  },
  {
    name: 'a list of codes tested for a code',
    pattern:
      /\[[^\]]*['"](?:NOT_FOUND|CONFLICT|NOT_CONFIGURED|BAD_REQUEST|RATE_LIMITED|UNSUPPORTED_CAPABILITY|STORAGE_UNAVAILABLE)['"][^\]]*\]\s*\.includes\(/,
  },
];

describe('the files under http', () => {
  it('map a BureauError only through the policy file', async () => {
    const httpDirectory = dirname(fileURLToPath(import.meta.url));
    const policyFile = join(httpDirectory, 'bureau-fault-policy.ts');
    const offences: string[] = [];
    let scanned = 0;
    for await (const path of new Glob('**/*.ts').scan({ cwd: httpDirectory, absolute: true })) {
      if (path === policyFile || /\.test(-support)?\.ts$/.test(path)) continue;
      scanned += 1;
      const text = await readFile(path, 'utf8');
      for (const { name, pattern } of FORBIDDEN_PATTERNS) {
        if (pattern.test(text)) offences.push(`${relative(httpDirectory, path)}: ${name}`);
      }
    }
    expect(scanned).toBeGreaterThan(50);
    expect(offences).toEqual([]);
  });

  it('catch each of the forbidden shapes', () => {
    const samples = [
      'if (error instanceof BureauError) {}',
      "if (error.code === 'NOT_FOUND') {}",
      "if (error.code !== 'BAD_REQUEST') {}",
      "case 'CONFLICT':",
      "['NOT_FOUND', 'CONFLICT'].includes(error.code)",
    ];
    for (const sample of samples) {
      expect(
        FORBIDDEN_PATTERNS.some(({ pattern }) => pattern.test(sample)),
        sample,
      ).toBe(true);
    }
  });
});

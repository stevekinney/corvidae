/**
 * COR-2518: one policy maps every `BureauError` to its fault, with remediation, and no operation
 * under `http` maps one of its own outside it.
 */
import {
  createOperationHandler,
  defineOperation,
  isFaultCode,
  principalFromApiKey,
  type OperationFault,
} from '@lostgradient/backchannel';
import { createAgent } from '@lostgradient/operative';
import { describe, expect, it, spyOn } from 'bun:test';
import { Glob } from 'bun';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { BUREAU_ERROR_CODES, BureauError, type BureauErrorCode } from '../bureau-errors.ts';
import {
  BUREAU_ERROR_FAULT_CODE,
  BUREAU_ERROR_REMEDIATION,
  bureauFault,
  bureauFaultOf,
  bureauFaultPolicy,
  bureauRefusalKind,
} from './bureau-fault-policy.ts';
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

const MAX_REMEDIATION_LENGTH = 500;

/** What the wire accepts of a remediation: one line of 1 to 500 characters, no control characters. */
function remediationProblem(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return 'empty';
  if (Array.from(value).length > MAX_REMEDIATION_LENGTH) return 'too long';
  if (/\p{Cc}/u.test(value)) return 'control character';
  return undefined;
}

describe('the Bureau fault policy', () => {
  it('maps every BureauError code to a fault code, and no other', () => {
    expect(Object.keys(BUREAU_ERROR_FAULT_CODE).toSorted()).toEqual(
      [...BUREAU_ERROR_CODES].toSorted(),
    );
    for (const code of BUREAU_ERROR_CODES) {
      expect(isFaultCode(BUREAU_ERROR_FAULT_CODE[code]), code).toBe(true);
      expect(bureauFault(errorOf(code)).code, code).toBe(BUREAU_ERROR_FAULT_CODE[code]);
    }
  });

  it('gives every code a remediation the wire accepts, and puts it on every fault it builds', () => {
    expect(Object.keys(BUREAU_ERROR_REMEDIATION).toSorted()).toEqual(
      [...BUREAU_ERROR_CODES].toSorted(),
    );
    for (const code of BUREAU_ERROR_CODES) {
      expect(remediationProblem(BUREAU_ERROR_REMEDIATION[code]), code).toBeUndefined();
      expect(bureauFault(errorOf(code)).remediation, code).toBe(BUREAU_ERROR_REMEDIATION[code]);
      for (const form of ['unprocessable', 'shutting-down'] as const) {
        const fault = bureauFault(errorOf(code), { forms: { [code]: form } });
        expect(fault.remediation, `${code} ${form}`).toBe(BUREAU_ERROR_REMEDIATION[code]);
      }
    }
  });

  it('names the resource, the field and the capability an operation passes in', () => {
    expect(
      bureauFault(errorOf('NOT_FOUND'), { notFound: { resource: 'run', identifier: 'r1' } }),
    ).toMatchObject({
      code: 'NotFound',
      message: 'No run with id "r1"',
      data: { resource: 'run', identifier: 'r1' },
    });
    expect(
      bureauFault(errorOf('BAD_REQUEST'), { invalidPath: ['input', 'payload'] }),
    ).toMatchObject({
      code: 'InvalidParams',
      data: { issues: [{ path: ['input', 'payload'], message: 'BAD_REQUEST message' }] },
    });
    expect(bureauFault(errorOf('NOT_CONFIGURED'))).toMatchObject({
      data: { capability: 'generate' },
    });
    expect(bureauFault(errorOf('NOT_CONFIGURED'), { capability: 'durable' })).toMatchObject({
      data: { capability: 'durable' },
    });
    expect(
      bureauFault(errorOf('CONFLICT'), { forms: { CONFLICT: 'shutting-down' } }),
    ).toMatchObject({ code: 'Unavailable', data: { reason: 'shutting-down' } });
  });

  it('does not repeat a storage outage message, which could name an internal', () => {
    const fault = bureauFault(
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
      const expected = bureauFault(errorOf(code));
      expect(body.error?.message, code).toBe(expected.message);
      expect(body.error?.data?.['remediation'], code).toBe(BUREAU_ERROR_REMEDIATION[code]);
      expect(body.error?.data?.['retryable'], code).toBeDefined();
      expect((expected as OperationFault).code, code).not.toBe('EngineFailure');
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

      expect(body.error?.data?.['remediation']).toBe(BUREAU_ERROR_REMEDIATION.STORAGE_UNAVAILABLE);
      expect(body.error?.message).not.toContain('10.0.0.7');
      expect(body.error?.code).not.toBe(-32603);
    } finally {
      await opened.dispose();
    }
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

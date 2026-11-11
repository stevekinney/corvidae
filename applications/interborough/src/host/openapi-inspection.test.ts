/**
 * COR-2009 — what the host says about an OpenAPI spec before it is connected (PageConnectTools,
 * "OpenAPI spec" and "OpenAPI, invalid spec and no operationIds").
 */
import { describe, expect, test } from 'bun:test';

import {
  inspectOpenApiAddress,
  inspectOpenApiSpec,
  lineOfTopLevelKey,
} from './openapi-inspection.ts';

/** Twenty-four operations over twelve paths: a GET and a DELETE under each. */
function paymentsPaths(withOperationIds: boolean): string {
  const lines: string[] = [];
  for (let index = 1; index <= 12; index += 1) {
    lines.push(`  /things-${String(index)}:`);
    lines.push('    get:');
    if (withOperationIds) lines.push(`      operationId: listThings${String(index)}`);
    lines.push(`      summary: List things ${String(index)}`);
    lines.push('    delete:');
    if (withOperationIds) lines.push(`      operationId: deleteThings${String(index)}`);
    lines.push(`      summary: Delete things ${String(index)}`);
  }
  return lines.join('\n');
}

/** A YAML spec whose `paths` key is on line 14 and holds a list, not an object. */
const PATHS_ON_LINE_14 = [
  'openapi: 3.1.0',
  'info:',
  '  title: Payments API',
  '  version: 1.0.0',
  '  description: >-',
  '    Payments, refunds and',
  '    the accounts they belong to.',
  'servers:',
  '  - url: https://payments.example.com/v1',
  'tags:',
  '  - name: refunds',
  '  - name: payments',
  '# Every operation of the API.',
  'paths:',
  '  - /refunds',
  '',
].join('\n');

const PAYMENTS = `openapi: 3.1.0
info:
  title: Payments API
  version: 1.0.0
servers:
  - url: https://payments.example.com/v1
paths:
  /refunds/{id}:
    get:
      operationId: getRefund
      summary: Get refund
      description: Reads one refund by its ID.
    delete:
      operationId: cancelRefund
      summary: Cancel refund
  /refunds:
    get:
      operationId: listRefunds
      summary: List refunds
      description: Lists refunds for the account.
    post:
      operationId: createRefund
      summary: Create refund
      requestBody:
        required: true
`;

describe('inspectOpenApiSpec', () => {
  test('an invalid file keeps its name and says what is wrong on which line', () => {
    expect(inspectOpenApiSpec(PATHS_ON_LINE_14, 'payments-openapi.yaml')).toEqual({
      outcome: 'invalid',
      fileName: 'payments-openapi.yaml',
      line: 14,
      problem: '“paths” must be an object.',
      message: 'This isn’t a valid OpenAPI 3 file. Line 14: “paths” must be an object.',
    });
  });

  test('a valid spec with no operationId names the problem with its operation count', () => {
    const spec = `openapi: 3.1.0\ninfo:\n  title: Payments API\npaths:\n${paymentsPaths(false)}\n`;
    expect(inspectOpenApiSpec(spec, 'payments-openapi.yaml')).toEqual({
      outcome: 'no-operation-ids',
      fileName: 'payments-openapi.yaml',
      version: '3.1',
      operationCount: 24,
      message:
        'None of the 24 operations has an operationId, and each tool needs one. Add operationIds to the spec, then upload it again.',
    });
  });

  test('a valid spec says its version, title, server, operations, and the GET Test connection calls', () => {
    const inspected = inspectOpenApiSpec(PAYMENTS, 'payments-openapi.yaml');
    expect(inspected).toMatchObject({
      outcome: 'valid',
      fileName: 'payments-openapi.yaml',
      version: '3.1',
      title: 'Payments API',
      baseUrl: 'https://payments.example.com/v1',
      operationCount: 4,
      // `getRefund` needs the path's `id`, so the first GET that needs nothing is List refunds.
      testOperation: {
        operationId: 'listRefunds',
        title: 'List refunds',
        method: 'GET',
        path: '/refunds',
      },
    });
    if (inspected.outcome !== 'valid') throw new Error('expected a valid spec');
    expect(
      inspected.operations.map(({ title, method, path, tier }) => [title, method, path, tier]),
    ).toEqual([
      ['Get refund', 'GET', '/refunds/{id}', 'read-only'],
      ['Cancel refund', 'DELETE', '/refunds/{id}', 'dangerous'],
      ['List refunds', 'GET', '/refunds', 'read-only'],
      ['Create refund', 'POST', '/refunds', 'mutating'],
    ]);
    expect(inspected.document['openapi']).toBe('3.1.0');
  });

  test('reads JSON, and a 24-operation spec with operationIds is valid', () => {
    const spec = `openapi: 3.0.3\ninfo:\n  title: T\npaths:\n${paymentsPaths(true)}\n`;
    expect(inspectOpenApiSpec(spec, null)).toMatchObject({
      outcome: 'valid',
      version: '3.0',
      operationCount: 24,
      testOperation: { operationId: 'listThings1', path: '/things-1' },
    });
    const json = JSON.stringify({ openapi: '3.1.0', info: { title: 'J' }, paths: [] }, null, 2);
    expect(inspectOpenApiSpec(json, 'spec.json')).toMatchObject({
      outcome: 'invalid',
      line: 6,
      problem: '“paths” must be an object.',
    });
  });

  test('a file that is not OpenAPI 3, or not YAML or JSON, says so', () => {
    expect(inspectOpenApiSpec('swagger: "2.0"\npaths: {}\n', 'old.yaml')).toMatchObject({
      outcome: 'invalid',
      line: 1,
      problem: '“openapi” must be a 3.x version, such as 3.1.0.',
    });
    const broken = inspectOpenApiSpec('openapi: 3.1.0\npaths:\n  /a: [\n', 'broken.yaml');
    expect(broken).toMatchObject({ outcome: 'invalid', fileName: 'broken.yaml' });
    if (broken.outcome !== 'invalid') throw new Error('expected an invalid spec');
    expect(broken.line).toBeGreaterThan(0);
    expect(broken.problem).toStartWith('The file can’t be read as YAML or JSON');
  });
});

describe('lineOfTopLevelKey', () => {
  test('finds a JSON key by depth, never a nested key of the same name', () => {
    const json = '{\n  "info": { "paths": 1 },\n  "paths": {}\n}';
    expect(lineOfTopLevelKey(json, 'paths')).toBe(3);
    expect(lineOfTopLevelKey(json, 'servers')).toBeNull();
  });
});

describe('inspectOpenApiAddress', () => {
  test('fetches a spec from its address, and reports an address that answers an error', async () => {
    const answered = await inspectOpenApiAddress('https://api.example.com/openapi.json', {
      fetch: (async () => new Response(PAYMENTS)) as unknown as typeof fetch,
    });
    expect(answered).toMatchObject({ outcome: 'valid', fileName: null, title: 'Payments API' });

    const missing = await inspectOpenApiAddress('https://api.example.com/openapi.json', {
      fetch: (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch,
    });
    expect(missing).toEqual({
      outcome: 'unreachable',
      status: 404,
      message:
        'Couldn’t fetch the spec. The address answered 404. Check it, or upload the file instead.',
    });
  });
});

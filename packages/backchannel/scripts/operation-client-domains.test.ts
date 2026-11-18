import { expect, test } from 'bun:test';

import type { CatalogOperationSnapshot } from '../src/index.ts';
import { createOperationClientSources } from './generate-operation-client.ts';
import { operationDomains } from './operation-client-domains.ts';
import { identityFormat } from './operation-client-test-support.ts';

function operation(name: string, tags: string[]): CatalogOperationSnapshot {
  return {
    name,
    tags,
    kind: 'unary',
    summary: name,
    destructive: false,
    access: { kind: 'public' },
    transports: { http: true, jsonRpcHttp: true, jsonRpcStdio: true, jsonRpcWebSocket: true },
    producibleFaults: [],
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
  };
}

test('every operation belongs to exactly one domain, its first tag by default', () => {
  const operations = [
    operation('probe.jobs.list', ['Jobs']),
    operation('probe.jobs.cancel', ['Jobs', 'Admin']),
    operation('probe.users.get', ['Users']),
    operation('probe.other.test', []),
  ];
  const domains = operationDomains(operations);
  expect(domains.map(({ name }) => name)).toEqual(['Jobs', 'Other', 'Users']);
  expect(
    domains
      .flatMap((domain) => domain.operations)
      .map(({ name }) => name)
      .toSorted(),
  ).toEqual(operations.map(({ name }) => name).toSorted());
});

test('a catalog can group operations by something other than their tag', () => {
  const domains = operationDomains(
    [operation('probe.jobs.bulk.cancel', ['Jobs']), operation('probe.jobs.list', ['Jobs'])],
    (candidate) => (candidate.name.includes('.bulk.') ? 'Bulk Jobs' : 'Jobs'),
  );
  expect(domains.map(({ name }) => name)).toEqual(['Bulk Jobs', 'Jobs']);
});

test('domain file collisions fail instead of overwriting an operation contract', () => {
  expect(() =>
    operationDomains([
      operation('probe.first.test', ['Task Diagnostics']),
      operation('probe.second.test', ['Task-Diagnostics']),
    ]),
  ).toThrow('Operation domains collide at task-diagnostics-operations.generated.ts');
  expect(() => operationDomains([operation('probe.invalid.test', ['---'])])).toThrow(
    'Operation domain requires an alphanumeric name',
  );
});

test('domain names cannot generate invalid or duplicate TypeScript identifiers', () => {
  expect(() => operationDomains([operation('probe.invalid.test', ['123 Tasks'])])).toThrow(
    'Operation domain must start with a letter',
  );
  expect(() =>
    operationDomains([
      operation('probe.first.test', ['Task Detail']),
      operation('probe.second.test', ['TaskDetail']),
    ]),
  ).toThrow('Operation domain types collide at TaskDetailOperationTypes');
});

test('an empty catalog emits a usable empty client without phantom domain imports', async () => {
  const sources = await createOperationClientSources(
    {
      generatedBy: 'weft catalog snapshot',
      version: 1,
      operations: [],
    },
    {
      packageName: '@example/probe',
      serverName: 'Probe',
      factoryName: 'createProbeClient',
      outputDirectory: 'src/generated',
      format: identityFormat,
    },
  );
  expect([...sources.keys()]).toEqual(['operation-client.generated.ts']);
  const client = sources.get('operation-client.generated.ts');
  expect(client).toContain('export type ClientOperationTypes = {};');
  expect(client).not.toContain('-operations.generated.ts');
});

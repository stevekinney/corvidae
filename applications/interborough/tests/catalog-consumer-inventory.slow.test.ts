import { expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';

import { createBureauCatalogSnapshot } from '@lostgradient/bureau';
import {
  CLIENT_OPERATION_NAMES,
  CLIENT_REST_OPERATION_BINDINGS,
  createCatalogSnapshot,
} from '@lostgradient/weft';
import { parse } from 'svelte/compiler';
import ts from 'typescript';

import { CLI_OPERATION_MAPPINGS } from '../src/host/cli-client.ts';
import {
  CLIENT_OPERATION_NAMES as BUREAU_CLIENT_NAMES,
  SUBSCRIPTION_OPERATION_NAMES,
} from '../src/lib/generated/bureau-operation-client.generated.ts';
import inventory from './catalog-consumer-inventory.json';
import { assertClassified, callerOf, scanTransport } from './catalog-consumer-transport.ts';

const sourceRoot = join(import.meta.dir, '../src');
const restMethods: Readonly<Record<string, string>> = {
  addTags: 'weft.workflows.tags.add',
  cancel: 'weft.workflows.cancel',
  cancelSchedule: 'weft.schedules.cancel',
  fork: 'weft.workflows.fork',
  get: 'weft.workflows.get',
  getEvents: 'weft.workflows.events.list',
  getSchedule: 'weft.schedules.get',
  getTimeline: 'weft.workflows.timeline.get',
  list: 'weft.workflows.list',
  listReviews: 'weft.reviews.list',
  listSchedules: 'weft.schedules.list',
  pauseSchedule: 'weft.schedules.pause',
  query: 'weft.workflows.query',
  removeTags: 'weft.workflows.tags.remove',
  replayTo: 'weft.workflows.replay',
  resume: 'weft.workflows.resume',
  resumeSchedule: 'weft.schedules.resume',
  schedule: 'weft.schedules.create',
  signal: 'weft.workflows.signal',
  start: 'weft.workflows.start',
  startOrSignal: 'weft.workflows.startorsignal',
  submitReview: 'weft.reviews.decision.submit',
  suspend: 'weft.workflows.suspend',
  timeout: 'weft.workflows.timeout',
  updateSchedule: 'weft.schedules.update',
  'activity.complete': 'weft.activities.complete',
  'activity.completeExceptionally': 'weft.activities.fail',
};

test('catalog consumers remain classified against the served catalogs', async () => {
  const names = new Set([
    ...createBureauCatalogSnapshot().operations.map((operation) => operation.name),
    ...createCatalogSnapshot().operations.map((operation) => operation.name),
  ]);
  const discovered: string[] = [];
  const discoveredRest: string[] = [];
  const discoveredCli: string[] = [];
  const discoveredGeneratedCli: string[] = [];
  const discoveredCliTemplates: string[] = [];
  const discoveredTransport: string[] = [];
  const discoveredMessages = new Set<string>();
  const discoveredImports: string[] = [];
  const transportSources = new Set([
    ...inventory.catalog.map((entry) => entry.path),
    ...inventory.eligible.map((entry) => entry.path),
    ...inventory.cli.map((entry) => entry.path),
    ...inventory.cliGenerated.map((entry) => entry.path),
    ...inventory.transportBoundaries.map((entry) => entry.path),
    ...inventory.dynamic.map((entry) => entry.path),
  ]);
  const trees: { path: string; tree: ts.SourceFile; source: string }[] = [];
  const constants = new Map<string, string>();
  for await (const path of new Bun.Glob('**/*.{ts,svelte}').scan({ cwd: sourceRoot })) {
    if (/\.(?:test|test-d|test-support|test-harness|test-fixture|generated|bench)\./u.test(path))
      continue;
    const source = await readFile(join(sourceRoot, path), 'utf8');
    if (
      /@modelcontextprotocol\/ext-apps|\.postMessage\(|addEventListener\(['"]message|new EventSource\(/u.test(
        source,
      )
    )
      discoveredMessages.add(path);
    const script = path.endsWith('.svelte')
      ? [...source.matchAll(/<script(?:\s[^>]*)?>([\s\S]*?)<\/script>/gu)]
          .map((match) => match[1])
          .join('\n')
      : source;
    const tree = ts.createSourceFile(path, script, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
    trees.push({ path, tree, source });
    function findConstants(node: ts.Node): void {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
        const initializer = ts.isAsExpression(node.initializer)
          ? node.initializer.expression
          : node.initializer;
        if (ts.isStringLiteral(initializer) && names.has(initializer.text)) {
          const existing = constants.get(node.name.text);
          if (existing !== undefined && existing !== initializer.text)
            throw new Error(`Ambiguous operation constant ${node.name.text}`);
          constants.set(node.name.text, initializer.text);
        }
      }
      ts.forEachChild(node, findConstants);
    }
    findConstants(tree);
  }
  function scanTrees(inputs: typeof trees): void {
    for (const { path, tree, source } of inputs) {
      const transport = scanTransport(path, tree);
      discoveredTransport.push(...transport.calls);
      function visit(node: ts.Node): void {
        if (
          ts.isImportDeclaration(node) &&
          ts.isStringLiteral(node.moduleSpecifier) &&
          node.importClause
        ) {
          const specifier = node.moduleSpecifier.text;
          const target = specifier.startsWith('.')
            ? relative(sourceRoot, resolve(dirname(join(sourceRoot, path)), specifier))
            : '';
          if (
            transportSources.has(target) ||
            /(?:bureau-api|\/lib\/client|\/client\.ts|host-(?:clean-up|panels|paths|plugins|providers|session|storage|tool-sources)|@ag-ui\/|@lostgradient\/(?:weft|backchannel\/client|bureau-client))/u.test(
              specifier,
            )
          )
            discoveredImports.push(
              `${path} ${specifier} ${node.importClause.getText(tree).replace(/\s+/gu, ' ')}`,
            );
        }
        if (/^host\/cli-(?!client|destructive).*\.ts$/u.test(path)) {
          if (
            ts.isStringLiteral(node) &&
            !ts.isLiteralTypeNode(node.parent) &&
            /^(?:bureau|weft)\.[a-z.]+$/u.test(node.text)
          ) {
            const generated =
              ts.isCallExpression(node.parent) &&
              ts.isIdentifier(node.parent.expression) &&
              node.parent.expression.text === 'catalogRead';
            (generated ? discoveredGeneratedCli : discoveredCli).push(
              `${path} ${callerOf(node, tree)} ${node.text}`,
            );
          }
          if (ts.isTemplateExpression(node) && /^(?:bureau|weft)\./u.test(node.head.text))
            discoveredCliTemplates.push(`${path} ${callerOf(node, tree)} ${node.getText(tree)}`);
        }
        if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
          const receiver = node.expression.expression.getText(tree);
          const method =
            receiver === 'client.activity'
              ? `activity.${node.expression.name.text}`
              : node.expression.name.text;
          if (
            (receiver === 'client' ||
              receiver.endsWith('.client') ||
              receiver === 'client.activity') &&
            Object.hasOwn(restMethods, method)
          )
            discoveredRest.push(`${path} ${callerOf(node, tree)} ${method}`);
          else if (
            (receiver === 'client' ||
              receiver.endsWith('.client') ||
              receiver === 'client.activity') &&
            /(?:getClient\(|\bHttpClient\b)/u.test(source)
          )
            throw new Error(
              `Unclassified Weft client call ${path}: ${node.expression.getText(tree)}`,
            );
        }
        if (
          ts.isPropertyAccessExpression(node) &&
          node.name.text === 'operations' &&
          (node.expression.getText(tree) === 'client' ||
            node.expression.getText(tree).endsWith('.client')) &&
          !ts.isElementAccessExpression(node.parent)
        )
          throw new Error(`Unclassified catalog accessor ${path}: ${node.getText(tree)}`);
        if (ts.isElementAccessExpression(node)) {
          const target = node.expression.getText(tree);
          if (
            target === 'bureauClient' ||
            target.endsWith('.operations') ||
            (target === 'client' &&
              ts.isStringLiteral(node.argumentExpression) &&
              node.argumentExpression.text.startsWith('bureau.'))
          ) {
            const argument = node.argumentExpression;
            const operation = ts.isStringLiteral(argument)
              ? argument.text
              : ts.isIdentifier(argument)
                ? constants.get(argument.text)
                : undefined;
            if (!operation)
              throw new Error(
                `Unclassified operation expression ${path}: ${argument.getText(tree)}`,
              );
            discovered.push(`${path} ${callerOf(node, tree)} ${operation}`);
          }
        }
        ts.forEachChild(node, visit);
      }
      visit(tree);
      if (path.endsWith('.svelte')) {
        const fragment = parse(source, { modern: true }).fragment;
        function visitMarkup(value: unknown): void {
          if (Array.isArray(value)) {
            for (const child of value) visitMarkup(child);
            return;
          }
          if (!value || typeof value !== 'object') return;
          const node = value as Record<string, unknown>;
          if (
            node['type'] === 'CallExpression' &&
            typeof node['start'] === 'number' &&
            typeof node['end'] === 'number'
          ) {
            const expression = source.slice(node['start'], node['end']);
            const fetchCall = /^(?:(\w+)|(?:[\w.]+)\.fetch|(?:[\w.]+)\[['"]fetch['"]\])\s*\(/u.exec(
              expression,
            );
            if (fetchCall && (!fetchCall[1] || transport.aliases.has(fetchCall[1])))
              discoveredTransport.push(`${path} <markup> ${expression.replace(/\s+/gu, ' ')}`);
            const call = /^(?:\w+\.)?client\.(activity\.)?(\w+)\s*\(/u.exec(expression);
            if (call) {
              const method = `${call[1] ?? ''}${call[2]}`;
              if (Object.hasOwn(restMethods, method))
                discoveredRest.push(`${path} <markup> ${method}`);
              else if (/(?:getClient\(|\bHttpClient\b)/u.test(source))
                throw new Error(`Unclassified Weft client call ${path}: ${expression}`);
            }
          }
          if (
            node['type'] === 'MemberExpression' &&
            node['computed'] === true &&
            typeof node['start'] === 'number' &&
            typeof node['end'] === 'number'
          ) {
            const expression = source.slice(node['start'], node['end']);
            const match = /^(?:bureauClient|\w+\.operations)\[(?:['"]([^'"]+)['"]|(\w+))\]$/u.exec(
              expression,
            );
            if (match) {
              const operation = match[1] ?? constants.get(match[2] ?? '');
              if (!operation)
                throw new Error(`Unclassified operation expression ${path}: ${expression}`);
              discovered.push(`${path} <markup> ${operation}`);
            }
          }
          for (const child of Object.values(node)) visitMarkup(child);
        }
        visitMarkup(fragment);
      }
    }
  }
  scanTrees(trees);
  for (const entry of inventory.catalog) {
    expect(names.has(entry.operation)).toBe(true);
    expect(entry.classification).toBe('generated');
    const restBinding = Object.hasOwn(CLIENT_REST_OPERATION_BINDINGS, entry.operation)
      ? CLIENT_REST_OPERATION_BINDINGS[
          entry.operation as keyof typeof CLIENT_REST_OPERATION_BINDINGS
        ]
      : undefined;
    const expectedTransport = restBinding
      ? `${restBinding.method} ${restBinding.path}`
      : (SUBSCRIPTION_OPERATION_NAMES as readonly string[]).includes(entry.operation)
        ? 'Bureau SSE subscription'
        : 'composed JSON-RPC';
    expect(entry.transport).toBe(expectedTransport);
    const generatedNames: readonly string[] = [
      ...CLIENT_OPERATION_NAMES,
      ...BUREAU_CLIENT_NAMES,
      ...SUBSCRIPTION_OPERATION_NAMES,
    ];
    expect(generatedNames.includes(entry.operation)).toBe(true);
  }
  assertClassified(
    discovered,
    inventory.catalog
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.operation}`),
      )
      .toSorted(),
  );
  for (const entry of inventory.eligible) {
    expect(names.has(entry.operation)).toBe(true);
    expect((CLIENT_OPERATION_NAMES as readonly string[]).includes(entry.operation)).toBe(true);
    expect(entry.classification).toBe('eligible');
    expect(restMethods[entry.method]).toBe(entry.operation);
    expect(entry.transport).toBe('Weft HTTP REST');
    expect(entry.issue).toMatch(/^COR-\d+$/u);
  }
  expect(discoveredRest.toSorted()).toEqual(
    inventory.eligible
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.method}`),
      )
      .toSorted(),
  );
  for (const entry of inventory.cli) {
    expect(names.has(entry.operation)).toBe(true);
    expect(
      ([...CLIENT_OPERATION_NAMES, ...BUREAU_CLIENT_NAMES] as readonly string[]).includes(
        entry.operation,
      ),
    ).toBe(true);
    expect(entry.classification).toBe('eligible');
    expect(entry.transport).toBe('Bureau JSON-RPC');
    expect(entry.issue).toMatch(/^COR-262[35]$/u);
  }
  for (const entry of inventory.cliGenerated) {
    expect(names.has(entry.operation)).toBe(true);
    expect((BUREAU_CLIENT_NAMES as readonly string[]).includes(entry.operation)).toBe(true);
    expect(entry.classification).toBe('generated');
    expect(entry.transport).toBe('Bureau JSON-RPC');
  }
  expect(discoveredGeneratedCli.toSorted()).toEqual(
    inventory.cliGenerated
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.operation}`),
      )
      .toSorted(),
  );
  expect(discoveredCli.toSorted()).toEqual(
    inventory.cli
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.operation}`),
      )
      .toSorted(),
  );
  expect(discoveredCliTemplates.toSorted()).toEqual(
    inventory.cliTemplates
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.expression}`),
      )
      .toSorted(),
  );
  for (const entry of inventory.cliTemplates) {
    const source = await readFile(join(sourceRoot, entry.path), 'utf8');
    expect(source.includes(entry.guard)).toBe(true);
    expect(entry.operations.length).toBeGreaterThan(0);
    for (const operation of entry.operations) expect(names.has(operation)).toBe(true);
    expect(entry.classification).toBe('eligible');
    expect(entry.transport).toBe('Bureau JSON-RPC');
    expect(entry.issue).toBe('COR-2625');
  }
  const cliOperations = new Set([
    ...inventory.cli.map((entry) => entry.operation),
    ...inventory.cliGenerated.map((entry) => entry.operation),
    ...inventory.cliTemplates.flatMap((entry) => entry.operations),
  ]);
  for (const operations of Object.values(CLI_OPERATION_MAPPINGS))
    for (const operation of operations)
      if (names.has(operation))
        expect(cliOperations.has(operation) || inventory.cliMetadataOnly.includes(operation)).toBe(
          true,
        );
  for (const operation of inventory.cliMetadataOnly)
    expect(cliOperations.has(operation)).toBe(false);
  expect(inventory.dynamic.map((entry) => entry.path).toSorted()).toEqual([
    'host/cli-client.ts',
    'host/composed-json-rpc.ts',
  ]);
  for (const entry of inventory.dynamic) {
    expect(entry.classification).toBe('catalog-dispatch');
    for (const field of [
      entry.catalog,
      entry.validation,
      entry.transport,
      entry.owner,
      entry.reason,
    ])
      expect(field.length).toBeGreaterThan(0);
  }
  assertClassified(
    discoveredTransport,
    inventory.transportBoundaries
      .flatMap((entry) => entry.expressions.map((expression) => `${entry.path} ${expression}`))
      .toSorted(),
  );
  for (const entry of inventory.transportBoundaries) {
    for (const field of [entry.classification, entry.transport, entry.owner, entry.reason])
      expect(field.length).toBeGreaterThan(0);
    expect(['generated', 'eligible', 'exceptional', 'boundary']).toContain(entry.classification);
    if ('operation' in entry) expect(names.has(entry.operation)).toBe(true);
    if ('operations' in entry)
      for (const operation of entry.operations) expect(names.has(operation)).toBe(true);
    if ('bindings' in entry)
      for (const binding of entry.bindings) {
        expect(names.has(binding.operation)).toBe(true);
        expect((CLIENT_OPERATION_NAMES as readonly string[]).includes(binding.operation)).toBe(
          false,
        );
        expect(binding.transport.length).toBeGreaterThan(0);
        expect(binding.reason.length).toBeGreaterThan(0);
      }
    if (entry.classification === 'eligible') {
      expect('issue' in entry && /^COR-262[35]$/u.test(entry.issue)).toBe(true);
      expect('operation' in entry || 'operations' in entry).toBe(true);
      const operations =
        'operations' in entry ? entry.operations : 'operation' in entry ? [entry.operation] : [];
      for (const operation of operations)
        expect((CLIENT_OPERATION_NAMES as readonly string[]).includes(operation)).toBe(true);
    }
    if (entry.classification === 'generated')
      expect(
        'operation' in entry &&
          (BUREAU_CLIENT_NAMES as readonly string[]).includes(entry.operation),
      ).toBe(true);
    if (entry.classification === 'exceptional' && 'operation' in entry)
      expect((CLIENT_OPERATION_NAMES as readonly string[]).includes(entry.operation)).toBe(false);
  }
  expect(discoveredImports.toSorted()).toEqual([...inventory.imports].toSorted());
  expect([...discoveredMessages].toSorted()).toEqual(
    inventory.messageBoundaries.map((entry) => entry.path).toSorted(),
  );
  for (const entry of inventory.messageBoundaries)
    for (const field of [entry.protocol, entry.owner, entry.reason])
      expect(field.length).toBeGreaterThan(0);
  const policyTree = trees.find(({ path }) => path === 'host/host-route-policy.ts')?.tree;
  if (!policyTree) throw new Error('Missing host route policy');
  const hostRoutes: string[] = [];
  function visitPolicy(node: ts.Node): void {
    if (
      ts.isVariableDeclaration(node) &&
      node.name.getText(policyTree) === 'routeClasses' &&
      node.initializer &&
      ts.isObjectLiteralExpression(node.initializer)
    ) {
      for (const property of node.initializer.properties)
        if (ts.isPropertyAssignment(property) && ts.isStringLiteral(property.name))
          hostRoutes.push(property.name.text);
    }
    ts.forEachChild(node, visitPolicy);
  }
  visitPolicy(policyTree);
  expect(hostRoutes.toSorted()).toEqual(
    inventory.hostRoutes.map((entry) => entry.route).toSorted(),
  );
  for (const entry of inventory.hostRoutes)
    for (const field of [entry.protocol, entry.owner, entry.reason])
      expect(field.length).toBeGreaterThan(0);
  for (const entry of inventory.delegatedBoundaries) {
    const source = await readFile(join(sourceRoot, entry.path), 'utf8');
    expect(source.includes(entry.anchor)).toBe(true);
    for (const field of [entry.protocol, entry.owner, entry.reason])
      expect(field.length).toBeGreaterThan(0);
  }
  const fixturePath = 'fixtures/unlisted-consumer.ts';
  const fixture = "function inspect() { return bureauClient['bureau.tasks.get']({}); }";
  const catalogBefore = discovered.length;
  scanTrees([
    {
      path: fixturePath,
      source: fixture,
      tree: ts.createSourceFile(fixturePath, fixture, ts.ScriptTarget.Latest, true),
    },
  ]);
  expect(() => assertClassified(discovered.slice(catalogBefore), [])).toThrow(
    'Unclassified call: fixtures/unlisted-consumer.ts inspect bureau.tasks.get',
  );
  const scopedBefore = discovered.length;
  scanTrees([
    {
      path: fixturePath,
      source: "function inspect(client: Client) { return client['bureau.tasks.get']({}); }",
      tree: ts.createSourceFile(
        fixturePath,
        "function inspect(client: Client) { return client['bureau.tasks.get']({}); }",
        ts.ScriptTarget.Latest,
        true,
      ),
    },
  ]);
  expect(() => assertClassified(discovered.slice(scopedBefore), [])).toThrow(
    'Unclassified call: fixtures/unlisted-consumer.ts inspect bureau.tasks.get',
  );
  const existingPath = 'app/engine-status.svelte.ts';
  const previous = "function probe() { return fetch('/v1/health'); }";
  const replacement = "function probe() { return fetch('/v1/unlisted'); }";
  const transportBefore = discoveredTransport.length;
  scanTrees([
    {
      path: existingPath,
      source: previous,
      tree: ts.createSourceFile(existingPath, previous, ts.ScriptTarget.Latest, true),
    },
  ]);
  const expectedTransport = discoveredTransport.slice(transportBefore);
  const replacementBefore = discoveredTransport.length;
  scanTrees([
    {
      path: existingPath,
      source: replacement,
      tree: ts.createSourceFile(existingPath, replacement, ts.ScriptTarget.Latest, true),
    },
  ]);
  expect(() =>
    assertClassified(discoveredTransport.slice(replacementBefore), expectedTransport),
  ).toThrow("Unclassified call: app/engine-status.svelte.ts probe fetch('/v1/unlisted')");
  expect(() =>
    assertClassified(
      [...expectedTransport, ...discoveredTransport.slice(replacementBefore)],
      expectedTransport,
    ),
  ).toThrow("Unclassified call: app/engine-status.svelte.ts probe fetch('/v1/unlisted')");
  for (const example of [
    "function probe() { return window.fetch('/unlisted'); }",
    "function probe() { return globalThis.fetch('/unlisted'); }",
    "function probe(client: Client) { return client.fetch('/unlisted'); }",
    "function probe(client: Client) { return client['fetch']('/unlisted'); }",
    "function probe() { const send = globalThis.fetch; return send('/unlisted'); }",
    "function probe() { const { fetch: send } = window; return send('/unlisted'); }",
    "function probe(fetcher: Fetcher) { return fetcher('/unlisted'); }",
    "function probe(request: Fetcher) { return request('/unlisted'); }",
    "function probe({ fetch: send }: Options) { return send('/unlisted'); }",
    "function probe() { const send = window.fetch; const relay = send; return relay('/unlisted'); }",
  ]) {
    const before = discoveredTransport.length;
    scanTrees([
      {
        path: existingPath,
        source: example,
        tree: ts.createSourceFile(existingPath, example, ts.ScriptTarget.Latest, true),
      },
    ]);
    const calls = discoveredTransport.slice(before);
    expect(calls.some((call) => call.includes("('/unlisted')"))).toBe(true);
    expect(() => assertClassified(calls, [])).toThrow(
      'Unclassified call: app/engine-status.svelte.ts',
    );
  }
});

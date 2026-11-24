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

const sourceRoot = join(import.meta.dir, '../src');
function callerOf(node: ts.Node, tree: ts.SourceFile): string {
  for (let current = node.parent; current; current = current.parent) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name)
      return current.name.getText(tree);
    if (
      (ts.isArrowFunction(current) || ts.isFunctionExpression(current)) &&
      ts.isVariableDeclaration(current.parent)
    )
      return current.parent.name.getText(tree);
  }
  return '<module>';
}
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
  const discoveredCliTemplates: string[] = [];
  const discoveredTransport: string[] = [];
  const discoveredMessages = new Set<string>();
  const discoveredImports: string[] = [];
  const transportSources = new Set([
    ...inventory.catalog.map((entry) => entry.path),
    ...inventory.eligible.map((entry) => entry.path),
    ...inventory.cli.map((entry) => entry.path),
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
  for (const { path, tree, source } of trees) {
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
      if (
        (ts.isCallExpression(node) &&
          ts.isIdentifier(node.expression) &&
          node.expression.text === 'fetch') ||
        (ts.isBinaryExpression(node) &&
          node.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken &&
          ts.isIdentifier(node.right) &&
          node.right.text === 'fetch') ||
        (ts.isParameter(node) &&
          node.initializer !== undefined &&
          ts.isIdentifier(node.initializer) &&
          node.initializer.text === 'fetch') ||
        (ts.isPropertyAccessExpression(node) &&
          node.expression.getText(tree) === 'globalThis' &&
          node.name.text === 'fetch')
      )
        discoveredTransport.push(path);
      if (/^host\/cli-(?!client|destructive).*\.ts$/u.test(path)) {
        if (ts.isStringLiteral(node) && /^(?:bureau|weft)\.[a-z.]+$/u.test(node.text))
          discoveredCli.push(`${path} ${callerOf(node, tree)} ${node.text}`);
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
        if (target === 'bureauClient' || target.endsWith('.operations')) {
          const argument = node.argumentExpression;
          const operation = ts.isStringLiteral(argument)
            ? argument.text
            : ts.isIdentifier(argument)
              ? constants.get(argument.text)
              : undefined;
          if (!operation)
            throw new Error(`Unclassified operation expression ${path}: ${argument.getText(tree)}`);
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
          typeof node['end'] === 'number' &&
          /^fetch\s*\(/u.test(source.slice(node['start'], node['end']))
        )
          discoveredTransport.push(path);
        if (
          node['type'] === 'CallExpression' &&
          typeof node['start'] === 'number' &&
          typeof node['end'] === 'number'
        ) {
          const expression = source.slice(node['start'], node['end']);
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
  expect(discovered.sort()).toEqual(
    inventory.catalog
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.operation}`),
      )
      .sort(),
  );
  for (const entry of inventory.eligible) {
    expect(names.has(entry.operation)).toBe(true);
    expect((CLIENT_OPERATION_NAMES as readonly string[]).includes(entry.operation)).toBe(true);
    expect(entry.classification).toBe('eligible');
    expect(restMethods[entry.method]).toBe(entry.operation);
    expect(entry.transport).toBe('Weft HTTP REST');
    expect(entry.issue).toMatch(/^COR-\d+$/u);
  }
  expect(discoveredRest.sort()).toEqual(
    inventory.eligible
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.method}`),
      )
      .sort(),
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
  expect(discoveredCli.sort()).toEqual(
    inventory.cli
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.operation}`),
      )
      .sort(),
  );
  expect(discoveredCliTemplates.sort()).toEqual(
    inventory.cliTemplates
      .flatMap((entry) =>
        Array<string>(entry.count).fill(`${entry.path} ${entry.caller} ${entry.expression}`),
      )
      .sort(),
  );
  for (const entry of inventory.cliTemplates) {
    expect((await readFile(join(sourceRoot, entry.path), 'utf8')).includes(entry.guard)).toBe(true);
    expect(entry.operations.length).toBeGreaterThan(0);
    for (const operation of entry.operations) expect(names.has(operation)).toBe(true);
    expect(entry.classification).toBe('eligible');
    expect(entry.transport).toBe('Bureau JSON-RPC');
    expect(entry.issue).toBe('COR-2625');
  }
  const cliOperations = new Set([
    ...inventory.cli.map((entry) => entry.operation),
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
  expect(inventory.dynamic.map((entry) => entry.path).sort()).toEqual([
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
  expect(discoveredTransport.sort()).toEqual(
    inventory.transportBoundaries
      .flatMap((entry) => Array<string>(entry.count).fill(entry.path))
      .sort(),
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
  expect(discoveredImports.sort()).toEqual([...inventory.imports].sort());
  expect([...discoveredMessages].sort()).toEqual(
    inventory.messageBoundaries.map((entry) => entry.path).sort(),
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
  expect(hostRoutes.sort()).toEqual(inventory.hostRoutes.map((entry) => entry.route).sort());
  for (const entry of inventory.hostRoutes)
    for (const field of [entry.protocol, entry.owner, entry.reason])
      expect(field.length).toBeGreaterThan(0);
  for (const entry of inventory.delegatedBoundaries) {
    expect((await readFile(join(sourceRoot, entry.path), 'utf8')).includes(entry.anchor)).toBe(
      true,
    );
    for (const field of [entry.protocol, entry.owner, entry.reason])
      expect(field.length).toBeGreaterThan(0);
  }
});

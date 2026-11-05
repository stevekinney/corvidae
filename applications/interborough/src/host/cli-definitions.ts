import { readFile } from 'node:fs/promises';

import { request, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';
import { executeRuns } from './cli-runs.ts';

type RecordValue = Record<string, unknown>;

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function identifier(parsed: Parsed, position = 1): string {
  const value = parsed.arguments[position];
  if (value === undefined || value === '')
    throw Object.assign(new Error(`${parsed.command} requires an identifier.`), { usage: true });
  return value;
}

function integerOption(parsed: Parsed, name: string): number | undefined {
  const value = option(parsed, name);
  if (value === undefined) return undefined;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0)
    throw Object.assign(new Error(`Option --${name} must be a nonnegative integer.`), {
      usage: true,
    });
  return number;
}

function requiredInteger(value: string | undefined, label: string): number {
  const number = value === undefined ? Number.NaN : Number(value);
  if (!Number.isInteger(number) || number <= 0)
    throw Object.assign(new Error(`${label} must be a positive integer.`), { usage: true });
  return number;
}

async function jsonInput(
  parsed: Parsed,
  dependencies: CliClientDependencies,
  names: readonly string[],
): Promise<unknown> {
  const source = names.map((name) => option(parsed, name)).find((value) => value !== undefined);
  if (source === undefined)
    throw Object.assign(new Error(`Option --${names[0]} is required.`), { usage: true });
  const text =
    source === '-'
      ? await (dependencies.stdin ?? (() => Bun.stdin.text()))()
      : await readFile(source, 'utf8');
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error(`Option --${names[0]} must contain valid JSON.`), {
      usage: true,
    });
  }
}

async function rpc(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  method: string,
  params: RecordValue,
): Promise<CliCommandResult> {
  const response = await request(target, '/bureau/jsonrpc', parsed, dependencies, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `cli-${crypto.randomUUID()}`,
      method,
      params,
    }),
  });
  const body = record(response.data);
  return body !== undefined && Object.hasOwn(body, 'result')
    ? { ...response, data: body['result'] }
    : response;
}

function expectedHash(parsed: Parsed): string {
  const value = option(parsed, 'if-revision') ?? option(parsed, 'expected-revision');
  if (value === undefined || value === '')
    throw Object.assign(new Error('Mutating an existing definition requires --if-revision.'), {
      usage: true,
    });
  return value;
}

async function agentCommand(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list')
    return rpc(target, parsed, dependencies, 'bureau.agents.definitions.list', {
      ...(integerOption(parsed, 'limit') === undefined
        ? {}
        : { limit: integerOption(parsed, 'limit') }),
      ...(integerOption(parsed, 'offset') === undefined
        ? {}
        : { offset: integerOption(parsed, 'offset') }),
    });
  if (action === 'models') return rpc(target, parsed, dependencies, 'bureau.agents.catalog', {});
  if (action === 'get')
    return rpc(target, parsed, dependencies, 'bureau.agents.definitions.get', {
      id: identifier(parsed),
    });
  if (action === 'duplicate')
    return rpc(target, parsed, dependencies, 'bureau.agents.definitions.duplicate', {
      id: identifier(parsed),
    });
  if (action === 'delete')
    return rpc(target, parsed, dependencies, 'bureau.agents.definitions.delete', {
      id: identifier(parsed),
      expectedHash: expectedHash(parsed),
    });
  if (action === 'versions') {
    const subcommand = parsed.arguments[1] ?? 'list';
    const id = identifier(parsed, 2);
    if (subcommand === 'list')
      return rpc(target, parsed, dependencies, 'bureau.agents.versions.list', { id });
    if (subcommand === 'restore')
      return rpc(target, parsed, dependencies, 'bureau.agents.versions.restore', {
        id,
        revision: requiredInteger(option(parsed, 'revision') ?? parsed.arguments[3], 'Revision'),
        expectedHash: expectedHash(parsed),
      });
  }
  if (action === 'try') {
    const message = option(parsed, 'message') ?? parsed.arguments[1];
    if (message === undefined || message === '')
      throw Object.assign(new Error('agents try requires --message.'), { usage: true });
    return rpc(target, parsed, dependencies, 'bureau.agents.try', {
      definition: await jsonInput(parsed, dependencies, ['file']),
      message,
    });
  }
  if (action === 'create' || action === 'update') {
    const id = identifier(parsed);
    const params: RecordValue = { id, definition: await jsonInput(parsed, dependencies, ['file']) };
    if (action === 'update') params['expectedHash'] = expectedHash(parsed);
    return rpc(target, parsed, dependencies, `bureau.agents.definitions.${action}`, params);
  }
  throw Object.assign(
    new Error('Usage: agents list|get|create|update|delete|duplicate|models|versions|try.'),
    {
      usage: true,
    },
  );
}

async function workflowCommand(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list')
    return rpc(target, parsed, dependencies, 'bureau.workflows.list', {
      ...(integerOption(parsed, 'limit') === undefined
        ? {}
        : { limit: integerOption(parsed, 'limit') }),
      ...(integerOption(parsed, 'offset') === undefined
        ? {}
        : { offset: integerOption(parsed, 'offset') }),
      ...(parsed.options.get('include-runs') === true ? { includeRuns: true } : {}),
    });
  if (action === 'get')
    return rpc(target, parsed, dependencies, 'bureau.workflows.get', { id: identifier(parsed) });
  if (action === 'history')
    return rpc(target, parsed, dependencies, 'bureau.workflows.history', {
      id: identifier(parsed),
    });
  if (action === 'signal') {
    const name = option(parsed, 'signal-name') ?? parsed.arguments[1];
    if (name === undefined || name === '')
      throw Object.assign(new Error('workflows signal requires a signal name.'), { usage: true });
    return rpc(target, parsed, dependencies, 'bureau.workflows.signal', {
      name,
      ...(option(parsed, 'signal-id') === undefined
        ? {}
        : { signalId: option(parsed, 'signal-id') }),
      ...(option(parsed, 'input-file') === undefined && option(parsed, 'input') === undefined
        ? {}
        : { payload: await jsonInput(parsed, dependencies, ['input-file', 'input']) }),
    });
  }
  if (action === 'start') {
    const id = identifier(parsed);
    const started = await rpc(target, parsed, dependencies, 'bureau.workflows.start', {
      id,
      ...(option(parsed, 'input-file') === undefined && option(parsed, 'input') === undefined
        ? {}
        : { input: await jsonInput(parsed, dependencies, ['input-file', 'input']) }),
    });
    if (parsed.options.get('wait') !== true) return started;
    const runId = record(started.data)['runId'];
    if (typeof runId !== 'string')
      throw Object.assign(new Error('Workflow start returned no run ID.'), { exitCode: 7 });
    const waitParsed = {
      ...parsed,
      command: 'runs',
      arguments: ['watch', runId],
      options: new Map([...parsed.options, ['kind', 'workflow']]),
    } satisfies Parsed;
    const observed = await executeRuns(target, waitParsed, dependencies);
    return { data: { started: started.data, observed: observed.data } };
  }
  if (action === 'validate' || action === 'create' || action === 'update') {
    const definition = await jsonInput(parsed, dependencies, ['file']);
    const params: RecordValue = { definition };
    if (action !== 'validate' || parsed.arguments[1] !== undefined)
      params['id'] = identifier(parsed);
    if (action === 'update') params['expectedHash'] = expectedHash(parsed);
    if (action === 'validate' && option(parsed, 'if-revision') !== undefined)
      params['expectedHash'] = expectedHash(parsed);
    return rpc(target, parsed, dependencies, `bureau.workflows.${action}`, params);
  }
  throw Object.assign(
    new Error('Usage: workflows list|get|create|update|validate|start|signal|history.'),
    {
      usage: true,
    },
  );
}

/** Execute agent-definition and workflow-management commands through Bureau JSON-RPC. */
export async function executeDefinitions(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if (parsed.command === 'agents') return agentCommand(target, parsed, dependencies);
  if (parsed.command === 'workflows') return workflowCommand(target, parsed, dependencies);
  throw Object.assign(new Error(`Unsupported command: ${parsed.command}`), { usage: true });
}

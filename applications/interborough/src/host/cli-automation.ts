import { open } from 'node:fs/promises';

import { request, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

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

function revision(parsed: Parsed): number | undefined {
  const value = option(parsed, 'if-revision') ?? option(parsed, 'expected-revision');
  if (value === undefined) return undefined;
  const parsedValue = Number(value);
  if (!Number.isInteger(parsedValue) || parsedValue < 0)
    throw Object.assign(new Error('Revision must be a nonnegative integer.'), { usage: true });
  return parsedValue;
}

async function inputFile(parsed: Parsed, dependencies: CliClientDependencies): Promise<unknown> {
  const path = option(parsed, 'file');
  if (path === undefined)
    throw Object.assign(new Error('This command requires --file.'), { usage: true });
  const text =
    path === '-'
      ? await (dependencies.stdin ?? (() => Bun.stdin.text()))()
      : await Bun.file(path).text();
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Option --file must contain valid JSON.'), { usage: true });
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
    body: JSON.stringify({ jsonrpc: '2.0', id: `cli-${crypto.randomUUID()}`, method, params }),
  });
  const body = record(response.data);
  return Object.hasOwn(body, 'result') ? { ...response, data: body['result'] } : response;
}

function guarded(parsed: Parsed, params: RecordValue): RecordValue {
  const expectedRevision = revision(parsed);
  return expectedRevision === undefined ? params : { ...params, expectedRevision };
}

async function writeSecret(parsed: Parsed, result: unknown): Promise<unknown> {
  const output = option(parsed, 'secret-output');
  const value = record(result)['signingSecret'];
  if (typeof value !== 'string') return result;
  if (output === undefined)
    return Object.fromEntries(
      Object.entries(record(result)).filter(([key]) => key !== 'signingSecret'),
    );
  const handle = await open(output, 'wx', 0o600);
  try {
    await handle.writeFile(`${value}\n`, 'utf8');
  } finally {
    await handle.close();
  }
  const { signingSecret: _secret, ...safe } = record(result);
  return { ...safe, secretOutput: output };
}

async function schedules(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list')
    return rpc(target, parsed, dependencies, 'bureau.schedules.list', {
      ...(option(parsed, 'limit') === undefined ? {} : { limit: Number(option(parsed, 'limit')) }),
      ...(option(parsed, 'offset') === undefined
        ? {}
        : { offset: Number(option(parsed, 'offset')) }),
    });
  if (action === 'create')
    return rpc(
      target,
      parsed,
      dependencies,
      'bureau.schedules.create',
      record(await inputFile(parsed, dependencies)),
    );
  const scheduleId = identifier(parsed);
  if (action === 'get')
    return rpc(target, parsed, dependencies, 'bureau.schedules.get', { scheduleId });
  if (action === 'update')
    return rpc(
      target,
      parsed,
      dependencies,
      'bureau.schedules.update',
      guarded(parsed, { scheduleId, ...record(await inputFile(parsed, dependencies)) }),
    );
  if (['pause', 'resume'].includes(action))
    return rpc(
      target,
      parsed,
      dependencies,
      `bureau.schedules.${action}`,
      guarded(parsed, { scheduleId }),
    );
  if (action === 'run')
    return rpc(target, parsed, dependencies, 'bureau.schedules.runnow', { scheduleId });
  if (action === 'skip-next') {
    const occurrence = option(parsed, 'occurrence') ?? parsed.arguments[2];
    if (occurrence === undefined)
      throw Object.assign(new Error('skip-next requires --occurrence.'), { usage: true });
    return rpc(
      target,
      parsed,
      dependencies,
      'bureau.schedules.skipnext',
      guarded(parsed, { scheduleId, occurrence }),
    );
  }
  throw Object.assign(
    new Error('Usage: schedules list|get|create|update|pause|resume|run|skip-next.'),
    { usage: true },
  );
}

async function goals(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list')
    return rpc(target, parsed, dependencies, 'bureau.goals.list', {
      ...(option(parsed, 'limit') === undefined ? {} : { limit: Number(option(parsed, 'limit')) }),
      ...(option(parsed, 'offset') === undefined
        ? {}
        : { offset: Number(option(parsed, 'offset')) }),
    });
  if (action === 'create')
    return rpc(
      target,
      parsed,
      dependencies,
      'bureau.goals.create',
      record(await inputFile(parsed, dependencies)),
    );
  const goalRunId = identifier(parsed);
  if (action === 'get') return rpc(target, parsed, dependencies, 'bureau.goals.get', { goalRunId });
  if (action === 'cancel')
    return rpc(target, parsed, dependencies, 'bureau.goals.cancel', guarded(parsed, { goalRunId }));
  throw Object.assign(new Error('Usage: goals list|get|create|cancel.'), { usage: true });
}

async function hooks(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list') return rpc(target, parsed, dependencies, 'bureau.hooks.list', {});
  if (action === 'create') {
    const response = await rpc(
      target,
      parsed,
      dependencies,
      'bureau.hooks.create',
      record(await inputFile(parsed, dependencies)),
    );
    return { data: await writeSecret(parsed, response.data) };
  }
  const hookId = identifier(parsed);
  if (action === 'get') return rpc(target, parsed, dependencies, 'bureau.hooks.get', { hookId });
  if (action === 'update') {
    const response = await rpc(
      target,
      parsed,
      dependencies,
      'bureau.hooks.update',
      guarded(parsed, { hookId, ...record(await inputFile(parsed, dependencies)) }),
    );
    return { data: await writeSecret(parsed, response.data) };
  }
  if (action === 'replace-secret') {
    const response = await rpc(
      target,
      parsed,
      dependencies,
      'bureau.hooks.secret.replace',
      guarded(parsed, { hookId }),
    );
    return { data: await writeSecret(parsed, response.data) };
  }
  if (action === 'delete' || action === 'test')
    return rpc(target, parsed, dependencies, `bureau.hooks.${action}`, { hookId });
  if (action === 'deliveries')
    return rpc(target, parsed, dependencies, 'bureau.hooks.deliveries', {
      hookId,
      ...(option(parsed, 'limit') === undefined ? {} : { limit: Number(option(parsed, 'limit')) }),
    });
  throw Object.assign(
    new Error('Usage: hooks list|get|create|update|replace-secret|delete|test|deliveries.'),
    { usage: true },
  );
}

/** Execute schedule, goal, and hook management commands through Bureau JSON-RPC. */
export async function executeAutomation(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if (parsed.command === 'schedules') return schedules(target, parsed, dependencies);
  if (parsed.command === 'goals') return goals(target, parsed, dependencies);
  if (parsed.command === 'hooks') return hooks(target, parsed, dependencies);
  throw Object.assign(new Error(`Unsupported command: ${parsed.command}`), { usage: true });
}

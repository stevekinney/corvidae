import { open } from 'node:fs/promises';

import { catalogCall, catalogFileCall, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';
import { cliPreview, isDryRun } from './cli-destructive.ts';

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

function guarded<Parameters extends RecordValue>(parsed: Parsed, params: Parameters) {
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
    return catalogCall(target, parsed, dependencies, 'bureau.schedules.list', {
      ...(option(parsed, 'limit') === undefined ? {} : { limit: Number(option(parsed, 'limit')) }),
      ...(option(parsed, 'offset') === undefined
        ? {}
        : { offset: Number(option(parsed, 'offset')) }),
    });
  if (action === 'create')
    return catalogFileCall(
      target,
      parsed,
      dependencies,
      'bureau.schedules.create',
      record(await inputFile(parsed, dependencies)),
    );
  const scheduleId = identifier(parsed);
  if (action === 'get')
    return catalogCall(target, parsed, dependencies, 'bureau.schedules.get', { scheduleId });
  if (action === 'update')
    return catalogFileCall(
      target,
      parsed,
      dependencies,
      'bureau.schedules.update',
      guarded(parsed, { scheduleId, ...record(await inputFile(parsed, dependencies)) }),
    );
  // Bureau has no dry run for a pause, so the CLI reads the schedule and says what it would send.
  if (action === 'pause' && isDryRun(parsed)) {
    const current = await catalogCall(target, parsed, dependencies, 'bureau.schedules.get', {
      scheduleId,
    });
    return cliPreview({
      target: { kind: 'schedule', id: scheduleId },
      current: record(current.data),
      wouldSend: { method: 'bureau.schedules.pause', params: guarded(parsed, { scheduleId }) },
    });
  }
  if (action === 'pause')
    return catalogCall(
      target,
      parsed,
      dependencies,
      'bureau.schedules.pause',
      guarded(parsed, { scheduleId }),
    );
  if (action === 'resume')
    return catalogCall(
      target,
      parsed,
      dependencies,
      'bureau.schedules.resume',
      guarded(parsed, { scheduleId }),
    );
  if (action === 'run')
    return catalogCall(target, parsed, dependencies, 'bureau.schedules.runnow', { scheduleId });
  if (action === 'skip-next') {
    const occurrence = option(parsed, 'occurrence') ?? parsed.arguments[2];
    if (occurrence === undefined)
      throw Object.assign(new Error('skip-next requires --occurrence.'), { usage: true });
    return catalogCall(
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
    return catalogCall(target, parsed, dependencies, 'bureau.goals.list', {
      ...(option(parsed, 'limit') === undefined ? {} : { limit: Number(option(parsed, 'limit')) }),
      ...(option(parsed, 'offset') === undefined
        ? {}
        : { offset: Number(option(parsed, 'offset')) }),
    });
  if (action === 'create')
    return catalogFileCall(
      target,
      parsed,
      dependencies,
      'bureau.goals.create',
      record(await inputFile(parsed, dependencies)),
    );
  const goalRunId = identifier(parsed);
  if (action === 'get')
    return catalogCall(target, parsed, dependencies, 'bureau.goals.get', { goalRunId });
  if (action === 'cancel')
    return catalogCall(
      target,
      parsed,
      dependencies,
      'bureau.goals.cancel',
      guarded(parsed, { goalRunId, ...(isDryRun(parsed) ? { dryRun: true } : {}) }),
    );
  throw Object.assign(new Error('Usage: goals list|get|create|cancel.'), { usage: true });
}

async function hooks(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list') return catalogCall(target, parsed, dependencies, 'bureau.hooks.list', {});
  if (action === 'create') {
    const response = await catalogFileCall(
      target,
      parsed,
      dependencies,
      'bureau.hooks.create',
      record(await inputFile(parsed, dependencies)),
    );
    return { data: await writeSecret(parsed, response.data) };
  }
  const hookId = identifier(parsed);
  if (action === 'get')
    return catalogCall(target, parsed, dependencies, 'bureau.hooks.get', { hookId });
  if (action === 'update') {
    const response = await catalogFileCall(
      target,
      parsed,
      dependencies,
      'bureau.hooks.update',
      guarded(parsed, { hookId, ...record(await inputFile(parsed, dependencies)) }),
    );
    return { data: await writeSecret(parsed, response.data) };
  }
  if (action === 'replace-secret') {
    const response = await catalogCall(
      target,
      parsed,
      dependencies,
      'bureau.hooks.secret.replace',
      guarded(parsed, { hookId }),
    );
    return { data: await writeSecret(parsed, response.data) };
  }
  if (action === 'delete')
    return catalogCall(target, parsed, dependencies, 'bureau.hooks.delete', {
      hookId,
      ...(isDryRun(parsed) ? { dryRun: true } : {}),
    });
  if (action === 'test')
    return catalogCall(target, parsed, dependencies, 'bureau.hooks.test', { hookId });
  if (action === 'deliveries')
    return catalogCall(target, parsed, dependencies, 'bureau.hooks.deliveries', {
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

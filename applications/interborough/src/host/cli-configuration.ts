import { readFile } from 'node:fs/promises';

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

async function input(parsed: Parsed, dependencies: CliClientDependencies): Promise<unknown> {
  const inline = option(parsed, 'input');
  const path = option(parsed, 'input-file') ?? option(parsed, 'file');
  if (inline !== undefined && path !== undefined)
    throw Object.assign(new Error('Use only one of --input and --input-file.'), { usage: true });
  if (inline === undefined && path === undefined) return {};
  const text =
    inline ??
    (path === '-'
      ? await (dependencies.stdin ?? (() => Bun.stdin.text()))()
      : await readFile(path!, 'utf8'));
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Configuration input must contain valid JSON.'), { usage: true });
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

function revisionOf(value: unknown): string | null {
  const row = record(value);
  for (const key of ['configurationRevision', 'revision']) {
    const candidate = row[key];
    if (typeof candidate === 'string' || typeof candidate === 'number') return String(candidate);
  }
  const catalog = record(row['catalog']);
  return typeof catalog['revision'] === 'number' ? String(catalog['revision']) : null;
}

function mutation(parsed: Parsed, expectedRevision: string | null): RecordValue {
  return {
    operationId: `cli-${crypto.randomUUID()}`,
    expectedRevision: option(parsed, 'expected-revision') ?? expectedRevision,
  };
}

async function secret(parsed: Parsed, dependencies: CliClientDependencies): Promise<string> {
  const file = option(parsed, 'secret-file');
  const fromStdin = parsed.options.get('secret-stdin') === true;
  if (file !== undefined && fromStdin)
    throw Object.assign(new Error('Use only one of --secret-file and --secret-stdin.'), {
      usage: true,
    });
  if (file !== undefined) {
    const value = await readFile(file, 'utf8');
    return value.trimEnd();
  }
  if (fromStdin) {
    const value = await (dependencies.stdin ?? (() => Bun.stdin.text()))();
    return value.trimEnd();
  }
  if (!parsed.noInput && dependencies.stdinIsTTY === true && dependencies.prompt !== undefined)
    return dependencies.prompt('Secret: ', dependencies.signal);
  throw Object.assign(
    new Error('A secret requires an interactive prompt, --secret-stdin, or --secret-file.'),
    {
      usage: true,
    },
  );
}

async function hostMutation(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
  path: string,
  method: 'PUT' | 'POST' | 'DELETE',
  body: RecordValue,
  revisionPath: string,
): Promise<CliCommandResult> {
  const current = await request(target, revisionPath, parsed, dependencies);
  const payload = { ...body, ...mutation(parsed, revisionOf(current.data)) };
  return request(target, path, parsed, dependencies, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

async function providers(target: CliTarget, parsed: Parsed, dependencies: CliClientDependencies) {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list') return request(target, '/host/providers', parsed, dependencies);
  const name = identifier(parsed, 1);
  if (action === 'disconnect')
    return hostMutation(
      target,
      parsed,
      dependencies,
      `/host/providers/${encodeURIComponent(name)}`,
      'DELETE',
      {},
      '/host/providers',
    );
  if (action === 'connect') {
    const value = record(await input(parsed, dependencies));
    const apiKey =
      typeof value['apiKey'] === 'string' ? value['apiKey'] : await secret(parsed, dependencies);
    return hostMutation(
      target,
      parsed,
      dependencies,
      `/host/providers/${encodeURIComponent(name)}`,
      'PUT',
      {
        ...value,
        provider: undefined,
        apiKey,
      },
      '/host/providers',
    );
  }
  throw Object.assign(
    new Error('Usage: providers list|connect <provider>|disconnect <provider>.'),
    { usage: true },
  );
}

async function toolSources(target: CliTarget, parsed: Parsed, dependencies: CliClientDependencies) {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list') return request(target, '/host/tool-sources', parsed, dependencies);
  const id = identifier(parsed, 1);
  if (action === 'remove')
    return hostMutation(
      target,
      parsed,
      dependencies,
      `/host/tool-sources/${encodeURIComponent(id)}`,
      'DELETE',
      {},
      '/host/tool-sources',
    );
  if (action === 'authorize') {
    const response = await hostMutation(
      target,
      parsed,
      dependencies,
      `/host/tool-sources/${encodeURIComponent(id)}/authorize`,
      'POST',
      {},
      '/host/tool-sources',
    );
    const data = record(response.data);
    const url = data['authorizationUrl'];
    if (typeof url === 'string' && parsed.options.get('no-open') !== true) {
      await (
        dependencies.open ??
        (async (address: string) => {
          await Bun.spawn(['open', address]).exited;
        })
      )(url);
    }
    return response;
  }
  if (action === 'probe')
    return hostMutation(
      target,
      parsed,
      dependencies,
      `/host/tool-sources/${encodeURIComponent(id)}/probe`,
      'POST',
      record(await input(parsed, dependencies)),
      '/host/tool-sources',
    );
  if (action === 'add' || action === 'update')
    return hostMutation(
      target,
      parsed,
      dependencies,
      `/host/tool-sources/${encodeURIComponent(id)}`,
      'PUT',
      {
        ...record(await input(parsed, dependencies)),
        ...(action === 'add' ? { create: true } : {}),
      },
      '/host/tool-sources',
    );
  throw Object.assign(
    new Error('Usage: tool-sources list|add|update|probe|authorize|remove <id>.'),
    { usage: true },
  );
}

async function plugins(target: CliTarget, parsed: Parsed, dependencies: CliClientDependencies) {
  const action = parsed.arguments[0] ?? 'list';
  if (action === 'list') return request(target, '/host/plugins', parsed, dependencies);
  const name = identifier(parsed, 1);
  if (action === 'enable' || action === 'disable')
    return hostMutation(
      target,
      parsed,
      dependencies,
      `/host/plugins/${encodeURIComponent(name)}`,
      'PUT',
      { enabled: action === 'enable' },
      '/host/plugins',
    );
  throw Object.assign(new Error('Usage: plugins list|enable|disable <plugin>.'), { usage: true });
}

async function settings(target: CliTarget, parsed: Parsed, dependencies: CliClientDependencies) {
  const action = parsed.arguments[0] ?? 'get';
  if (action === 'get') return rpc(target, parsed, dependencies, 'bureau.settings.get', {});
  if (action === 'schema') return rpc(target, parsed, dependencies, 'bureau.settings.schema', {});
  if (action === 'set') {
    const current = await rpc(target, parsed, dependencies, 'bureau.settings.get', {});
    const patch = record(await input(parsed, dependencies));
    const revision = record(current.data)['revision'];
    if (typeof revision !== 'number' && option(parsed, 'expected-revision') === undefined)
      throw new Error('The settings response did not include a revision.');
    return rpc(target, parsed, dependencies, 'bureau.settings.update', {
      patch,
      expectedRevision: Number(option(parsed, 'expected-revision') ?? revision),
    });
  }
  throw Object.assign(new Error('Usage: settings get|set|schema.'), { usage: true });
}

/** Execute provider, model, tool, plugin, skill, and settings configuration commands. */
export async function executeConfiguration(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if (parsed.command === 'providers') return providers(target, parsed, dependencies);
  if (parsed.command === 'models') {
    const result = await rpc(target, parsed, dependencies, 'bureau.agents.catalog', {});
    return { ...result, data: record(result.data)['models'] ?? [] };
  }
  if (parsed.command === 'tools') {
    const result = await rpc(target, parsed, dependencies, 'bureau.agents.catalog', {});
    return { ...result, data: record(result.data)['tools'] ?? [] };
  }
  if (parsed.command === 'tool-sources') return toolSources(target, parsed, dependencies);
  if (parsed.command === 'plugins') return plugins(target, parsed, dependencies);
  if (parsed.command === 'skills')
    return rpc(target, parsed, dependencies, 'bureau.skills.list', {});
  if (parsed.command === 'settings') return settings(target, parsed, dependencies);
  throw Object.assign(new Error(`Unsupported command: ${parsed.command}`), { usage: true });
}

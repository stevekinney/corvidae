import { request, type CliTarget } from './cli-client-transport.ts';
import type { CliClientDependencies, CliCommandResult, Parsed } from './cli-client.ts';

type RecordValue = Record<string, unknown>;

function option(parsed: Parsed, name: string): string | undefined {
  const value = parsed.options.get(name);
  return typeof value === 'string' ? value : undefined;
}

function record(value: unknown): RecordValue {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : {};
}

function identifier(parsed: Parsed, position = 1): string {
  const value = parsed.arguments[position];
  if (value === undefined || value === '')
    throw Object.assign(new Error(`${parsed.command} requires an identifier.`), { usage: true });
  return value;
}

function agent(parsed: Parsed): string {
  const value = option(parsed, 'agent');
  if (value === undefined || value === '')
    throw Object.assign(new Error('Memory commands require --agent.'), { usage: true });
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

function memoryInput(parsed: Parsed): string {
  const positionalIndex = parsed.arguments[0] === 'correct' ? 2 : 1;
  const value = option(parsed, 'content') ?? parsed.arguments[positionalIndex];
  if (value === undefined || value.trim() === '')
    throw Object.assign(new Error('Memory content requires --content or positional content.'), {
      usage: true,
    });
  return value;
}

async function memory(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  const action = parsed.arguments[0] ?? 'list';
  const agentId = agent(parsed);
  if (action === 'list')
    return rpc(target, parsed, dependencies, 'bureau.memory.list', {
      agentId,
      ...(integerOption(parsed, 'limit') === undefined
        ? {}
        : { limit: integerOption(parsed, 'limit') }),
      ...(integerOption(parsed, 'offset') === undefined
        ? {}
        : { offset: integerOption(parsed, 'offset') }),
    });
  if (action === 'search')
    return rpc(target, parsed, dependencies, 'bureau.memory.search', {
      agentId,
      query: option(parsed, 'query') ?? parsed.arguments[1] ?? '',
      ...(integerOption(parsed, 'limit') === undefined
        ? {}
        : { limit: integerOption(parsed, 'limit') }),
    });
  if (action === 'export') {
    const response = await rpc(target, parsed, dependencies, 'bureau.memory.export', { agentId });
    const value = record(response.data);
    const memories = Array.isArray(value['memories']) ? value['memories'] : [];
    const limit = integerOption(parsed, 'limit') ?? (memories.length || 1);
    const offset = integerOption(parsed, 'offset') ?? 0;
    const page = memories.slice(offset, offset + limit);
    return {
      data: { ...value, memories: page },
      metadata: {
        cursor: offset + page.length < memories.length ? String(offset + page.length) : null,
        page: { limit, offset },
      },
    };
  }
  if (action === 'get')
    return rpc(target, parsed, dependencies, 'bureau.memory.get', {
      agentId,
      id: identifier(parsed),
    });
  if (action === 'remember')
    return rpc(target, parsed, dependencies, 'bureau.memory.remember', {
      agentId,
      content: memoryInput(parsed),
      ...(option(parsed, 'kind') === undefined ? {} : { kind: option(parsed, 'kind') }),
    });
  if (action === 'correct')
    return rpc(target, parsed, dependencies, 'bureau.memory.correct', {
      agentId,
      id: identifier(parsed),
      content: memoryInput(parsed),
    });
  if (action === 'forget') {
    if (parsed.options.get('yes') !== true)
      throw Object.assign(new Error('memory forget is destructive; pass --yes to confirm.'), {
        exitCode: 5,
      });
    return rpc(target, parsed, dependencies, 'bureau.memory.forget', {
      agentId,
      id: identifier(parsed),
    });
  }
  throw Object.assign(new Error('Usage: memory list|search|get|remember|correct|forget|export.'), {
    usage: true,
  });
}

/** Execute caller-scoped Bureau memory commands. */
export function executeMemory(
  target: CliTarget,
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  return memory(target, parsed, dependencies);
}

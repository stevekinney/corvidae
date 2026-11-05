import { readFile } from 'node:fs/promises';

import { createCatalogSnapshot } from '@lostgradient/weft';

import { executeChat, executeReviewsOrRuns } from './cli-chat.ts';
import { executeConnection } from './cli-client-connections.ts';
import { readPreferences } from './cli-client-preferences.ts';
import { request } from './cli-client-transport.ts';
/** Version of the CLI JSON envelope. */
export const CLI_SCHEMA_VERSION = 1;
/** Default loopback management endpoint. */
export const CLI_DEFAULT_URL = 'http://127.0.0.1:7234';

/** Supported command output encodings. */
export type OutputFormat = 'text' | 'json' | 'jsonl';
/** Stable command exit vocabulary. */
export type CliExitCode = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 130;
type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

/** Result returned by the command runner. */
export type CliResult = {
  /** Serialized result for stdout. */
  readonly stdout: string;
  /** Diagnostics for stderr. */
  readonly stderr: string;
  /** Stable scripting exit code. */
  readonly exitCode: CliExitCode;
};

/** Metadata for one locally configured management connection. */
export type CliConnection = {
  /** User-facing connection name. */
  readonly name: string;
  /** Loopback management endpoint. */
  readonly url: string;
  /** Environment variable name containing a credential. */
  readonly credentialReference?: string;
};

/** Parsed and validated command arguments. */
export type Parsed = {
  /** Top-level command. */
  readonly command: string;
  /** Positional command arguments. */
  readonly arguments: readonly string[];
  /** Validated command options. */
  readonly options: ReadonlyMap<string, string | boolean>;
  /** Requested output encoding. */
  readonly output: OutputFormat;
  /** Whether prompts are prohibited. */
  readonly noInput: boolean;
  /** Client deadline in milliseconds. */
  readonly timeout: number;
  /** Selected connection name. */
  readonly connection?: string;
  /** Explicit endpoint override. */
  readonly url?: string;
};
type CliFailure = Error & { status?: number; usage?: boolean; exitCode?: CliExitCode };

/** Injectable process boundaries used by the command client. */
export type CliClientDependencies = {
  /** Injected HTTP implementation. */
  readonly fetch?: Fetcher;
  /** Injected platform URL opener. */
  readonly open?: (url: string) => Promise<void> | void;
  /** Preferences file location. */
  readonly preferencesPath?: string;
  /** Environment used for home and credential lookup. */
  readonly environment?: NodeJS.ProcessEnv;
  /** Optional clock seam. */
  readonly now?: () => number;
  /** Optional input stream seam. */
  readonly stdin?: () => Promise<string>;
  /** Optional interrupt signal. */
  readonly signal?: AbortSignal;
  /** Optional sink used by interactive streams for incremental terminal output. */
  readonly writeStdout?: (chunk: string) => void;
};

/** Unserialized command payload before output formatting. */
export type CliCommandResult = {
  /** Command payload. */
  readonly data: unknown;
  /** Non-sensitive response metadata. */
  readonly metadata?: Record<string, unknown>;
};

/** The externally callable operations this client exposes to later command work. */
export const CLI_OPERATION_INVENTORY = [
  'connection.list',
  'connection.add',
  'connection.use',
  'connection.remove',
  'whoami',
  'status',
  'doctor',
  'open',
  'restart',
  'api.list',
  'api.describe',
  'api.call',
] as const;

const optionNames = new Set([
  'all',
  'connection',
  'cursor',
  'credential-reference',
  'describe',
  'file',
  'help',
  'input',
  'input-file',
  'limit',
  'no-input',
  'output',
  'timeout',
  'url',
  'workspace',
  'yes',
  'agent',
  'message-file',
  'message',
  'thread',
  'run',
  'context',
  'input-id',
  'command-id',
  'through-message-id',
  'title',
  'wait',
  'model',
  'effort',
  'permission-mode',
  'expected-revision',
  'review-id',
  'round',
  'reason',
  'task-id',
  'message-id',
  'answer',
  'decision',
  'signal-name',
  'call-id',
]);

const commandOptions: Record<string, readonly string[]> = {
  connection: [
    'help',
    'output',
    'no-input',
    'url',
    'credential-reference',
    'limit',
    'cursor',
    'all',
  ],
  whoami: ['help', 'output', 'no-input', 'connection', 'url', 'timeout'],
  status: ['help', 'output', 'no-input', 'connection', 'url', 'timeout'],
  doctor: ['help', 'output', 'no-input', 'connection', 'url', 'timeout'],
  open: ['help', 'output', 'no-input', 'connection', 'url', 'timeout'],
  restart: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'yes'],
  api: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'all',
    'cursor',
    'describe',
    'file',
    'input',
    'input-file',
    'limit',
    'yes',
  ],
  chat: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'agent',
    'message-file',
    'message',
    'thread',
    'run',
  ],
  chats: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'context',
    'message',
    'input-id',
    'command-id',
    'through-message-id',
    'title',
    'wait',
    'model',
    'effort',
    'permission-mode',
    'expected-revision',
  ],
  reviews: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'review-id',
    'round',
    'reason',
    'yes',
  ],
  runs: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'task-id',
    'message-id',
    'answer',
    'decision',
    'signal-name',
    'call-id',
    'reason',
  ],
};

const helpText: Record<string, string> = {
  connection:
    'Usage: interborough connection <list|add|use|remove> [options]\n\n  --url <url>  Loopback management endpoint\n  --credential-reference <ENV>  Environment variable name (never stored value)',
  whoami: 'Usage: interborough whoami [options]',
  status: 'Usage: interborough status [options]',
  doctor: 'Usage: interborough doctor [options]',
  open: 'Usage: interborough open [options]',
  restart: 'Usage: interborough restart [options]\n\n  --yes  Confirm the restart request',
  api: 'Usage: interborough api <list|describe|call> [operation] [options]\n\n  --input-file <path>  JSON input, or - for stdin\n  --all  Explicitly request all pages',
  chat: 'Usage: interborough chat --agent <name> [message]\n\n  --message-file <path>  Read one message from a file',
  chats: 'Usage: interborough chats <list|get|send|fork|rename|delete|configure> [options]',
  reviews: 'Usage: interborough reviews <list|get|approve|reject> [options]',
  runs: 'Usage: interborough runs respond <task> [options]',
};
const catalogByName = new Map(
  createCatalogSnapshot().operations.map((operation) => [operation.name, operation]),
);

function usage(message: string): CliResult {
  return { stdout: '', stderr: message, exitCode: 2 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parse(arguments_: readonly string[]): Parsed | CliResult {
  const [command = '', ...rest] = arguments_;
  if (!(command in commandOptions)) return usage(`Unknown command: ${command || '<missing>'}`);
  const allowed = new Set(commandOptions[command]);
  const values = new Map<string, string | boolean>();
  const positional: string[] = [];
  for (let index = 0; index < rest.length; index += 1) {
    const argument = rest[index];
    if (argument === undefined) continue;
    if (!argument.startsWith('--')) {
      positional.push(argument);
      continue;
    }
    const equals = argument.indexOf('=');
    const name = (equals === -1 ? argument.slice(2) : argument.slice(2, equals)).trim();
    if (!optionNames.has(name) || !allowed.has(name)) return usage(`Unknown option --${name}.`);
    if (values.has(name)) return usage(`Duplicate option --${name}.`);
    const inline = equals === -1 ? undefined : argument.slice(equals + 1);
    const booleanOption = ['all', 'help', 'no-input', 'yes'].includes(name);
    if (booleanOption) {
      if (inline !== undefined) return usage(`Option --${name} does not take a value.`);
      values.set(name, true);
      continue;
    }
    const value = inline ?? rest[++index];
    if (value === undefined || value.startsWith('--'))
      return usage(`Option --${name} needs a value.`);
    values.set(name, value);
  }
  if (values.get('help') === true) {
    return {
      stdout: helpText[command] ?? 'Usage: interborough <command>',
      stderr: '',
      exitCode: 0,
    };
  }
  const outputValue = values.get('output') ?? 'text';
  if (outputValue !== 'text' && outputValue !== 'json' && outputValue !== 'jsonl')
    return usage('Option --output must be text, json, or jsonl.');
  if (outputValue === 'jsonl' && command !== 'api' && command !== 'chat')
    return usage('JSONL output is only supported for streams.');
  if (outputValue === 'jsonl' && command === 'api' && values.get('help') !== true)
    return usage('JSONL output is only supported for streaming API calls.');
  const timeoutValue = values.get('timeout');
  const timeout = timeoutValue === undefined ? 30_000 : Number(timeoutValue);
  if (!Number.isInteger(timeout) || timeout <= 0)
    return usage('Option --timeout must be a positive integer.');
  const options = values;
  return {
    command,
    arguments: positional,
    options,
    output: outputValue,
    noInput: options.get('no-input') === true,
    timeout,
    ...(typeof options.get('connection') === 'string'
      ? { connection: String(options.get('connection')) }
      : {}),
    ...(typeof options.get('url') === 'string' ? { url: String(options.get('url')) } : {}),
  };
}

/** Parse and validate a command without performing side effects. */
export function parseCliArguments(arguments_: readonly string[]): CliResult | Parsed {
  return parse(arguments_);
}

/** Validate and parse a supported local management endpoint. */
export function loopbackUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname))
      return undefined;
    return url;
  } catch {
    return undefined;
  }
}

async function resolveTarget(
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<{ url: string; headers: Record<string, string> } | CliResult> {
  const environment = { ...dependencies.environment };
  const preferences = await readPreferences(dependencies);
  const connection =
    parsed.connection === undefined
      ? preferences.connections.find((entry) => entry.name === preferences.activeConnection)
      : preferences.connections.find((entry) => entry.name === parsed.connection);
  if (parsed.connection !== undefined && connection === undefined)
    return { stdout: '', stderr: `Unknown connection: ${parsed.connection}.`, exitCode: 1 };
  const raw = parsed.url ?? connection?.url ?? CLI_DEFAULT_URL;
  const credential =
    connection?.credentialReference === undefined
      ? undefined
      : environment[connection.credentialReference];
  if (connection?.credentialReference !== undefined && credential === undefined)
    return {
      stdout: '',
      stderr: `Credential environment variable ${connection.credentialReference} is not set.`,
      exitCode: 3,
    };
  if (loopbackUrl(raw) === undefined)
    return {
      stdout: '',
      stderr: 'Management endpoints must be http://localhost or http://127.0.0.1.',
      exitCode: 3,
    };
  return {
    url: raw.replace(/\/$/, ''),
    headers: credential === undefined ? {} : { authorization: `Bearer ${credential}` },
  };
}

function envelope(result: CliCommandResult): Record<string, unknown> {
  return { schemaVersion: CLI_SCHEMA_VERSION, data: result.data, metadata: result.metadata ?? {} };
}

function render(parsed: Parsed, result: CliCommandResult): string {
  const value = envelope(result);
  if (parsed.output === 'jsonl' && Array.isArray(result.data))
    return result.data.map((item) => JSON.stringify({ ...value, data: item })).join('\n');
  if (parsed.output === 'json') return JSON.stringify(value, null, 2);
  if (typeof result.data === 'string') return result.data;
  return JSON.stringify(result.data, null, 2);
}

function makeCliFailure(message: string, properties: Partial<CliFailure> = {}): CliFailure {
  return Object.assign(new Error(message), properties);
}

function isCliExitCode(value: unknown): value is CliExitCode {
  return (
    value === 0 ||
    value === 1 ||
    value === 2 ||
    value === 3 ||
    value === 4 ||
    value === 5 ||
    value === 6 ||
    value === 7 ||
    value === 130
  );
}

async function execute(
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if (parsed.command === 'connection') return executeConnection(parsed, dependencies, loopbackUrl);
  const resolved = await resolveTarget(parsed, dependencies);
  if ('exitCode' in resolved) return { data: undefined, metadata: { error: resolved.stderr } };
  if (parsed.command === 'open') {
    await (
      dependencies.open ??
      (async (target: string) => {
        await Bun.spawn(['open', target]).exited;
      })
    )(resolved.url);
    return { data: { url: resolved.url } };
  }
  if (parsed.command === 'chat' || parsed.command === 'chats')
    return executeChat(resolved, parsed, dependencies);
  if (parsed.command === 'reviews' || parsed.command === 'runs')
    return executeReviewsOrRuns(resolved, parsed, dependencies);
  if (parsed.command === 'restart') {
    if (parsed.options.get('yes') !== true)
      throw makeCliFailure(
        parsed.noInput
          ? 'restart requires --yes when --no-input is set.'
          : 'restart is destructive; pass --yes to confirm.',
        { exitCode: parsed.noInput ? 5 : 2 },
      );
    const baseline = await request(resolved, '/host/status', parsed, dependencies);
    const baselineData = isRecord(baseline.data) ? baseline.data : undefined;
    const deploymentId = baselineData?.['deploymentId'];
    const incarnationId = baselineData?.['incarnationId'];
    if (
      typeof deploymentId !== 'string' ||
      typeof incarnationId !== 'string' ||
      incarnationId === ''
    )
      throw makeCliFailure('Host status capability is unavailable or malformed.', { exitCode: 1 });
    const acknowledged = await request(resolved, '/host/restart', parsed, dependencies, {
      method: 'POST',
    });
    const deadline = Date.now() + parsed.timeout;
    let observed: CliCommandResult | undefined;
    while (Date.now() < deadline) {
      try {
        const candidate = await request(resolved, '/host/status', parsed, dependencies);
        const value = isRecord(candidate.data) ? candidate.data : undefined;
        if (value?.['deploymentId'] !== deploymentId)
          throw makeCliFailure('The host deployment changed during restart.', { exitCode: 7 });
        if (typeof value?.['incarnationId'] !== 'string' || value['incarnationId'] === '')
          throw makeCliFailure('The host status response is malformed during restart.', {
            exitCode: 7,
          });
        if (value['incarnationId'] !== incarnationId) {
          observed = candidate;
          break;
        }
      } catch (error) {
        if (isRecord(error) && typeof error['exitCode'] === 'number') throw error;
        if (isRecord(error) && (error['status'] === 401 || error['status'] === 403))
          throw makeCliFailure('Restart observation was unauthorized.', { exitCode: 7 });
      }
      // poll-reason: timer
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (observed === undefined)
      throw makeCliFailure('Restart outcome is unknown.', { exitCode: 7 });
    return {
      data: { acknowledged: acknowledged.data, observed: observed.data },
      metadata: { restart: 'observed' },
    };
  }
  if (parsed.command === 'whoami')
    return {
      data: { actor: 'anonymous:local', workspace: null, capabilities: ['local-loopback'] },
    };
  if (parsed.command === 'status' || parsed.command === 'doctor') {
    const status = await request(resolved, '/host/status', parsed, dependencies);
    const statusData = isRecord(status.data) ? status.data : undefined;
    const data = {
      deployment: {
        identity:
          typeof statusData?.['deploymentId'] === 'string' ? statusData['deploymentId'] : null,
        capability: statusData === undefined ? 'unavailable' : 'available',
      },
      reachability: { reachable: true, url: resolved.url },
      host: { status: status.data },
    };
    return parsed.command === 'status' ? { data } : { data, metadata: { redacted: true } };
  }
  if (parsed.command === 'api') {
    const action = parsed.arguments[0];
    if (action === 'list') {
      const document = await request(resolved, '/openrpc.json', parsed, dependencies);
      const methods =
        isRecord(document.data) && Array.isArray(document.data['methods'])
          ? document.data['methods']
          : [];
      const limitValue = parsed.options.get('limit');
      const limit = limitValue === undefined ? 50 : Number(limitValue);
      if (!Number.isInteger(limit) || limit <= 0)
        throw makeCliFailure('Option --limit must be a positive integer.', { usage: true });
      const cursor = String(parsed.options.get('cursor') ?? '');
      const start = cursor === '' ? 0 : Number(cursor);
      if (!Number.isInteger(start) || start < 0)
        throw makeCliFailure('Option --cursor must be a nonnegative page cursor.', { usage: true });
      const selected =
        parsed.options.get('all') === true ? methods : methods.slice(start, start + limit);
      const nextCursor =
        parsed.options.get('all') === true || start + selected.length >= methods.length
          ? null
          : String(start + selected.length);
      return {
        data: selected.flatMap((method) => {
          const name =
            isRecord(method) && typeof method['name'] === 'string' ? method['name'] : undefined;
          const operation = name === undefined ? undefined : catalogByName.get(name);
          return operation === undefined
            ? []
            : [
                {
                  ...method,
                  kind: operation.kind,
                  destructive: operation.destructive,
                  transports: operation.transports,
                },
              ];
        }),
        metadata: {
          cursor: nextCursor,
          page: {
            limit: parsed.options.get('all') === true ? null : limit,
            all: parsed.options.get('all') === true,
          },
        },
      };
    }
    if (action === 'describe') {
      if (!parsed.arguments[1])
        throw Object.assign(new Error('api describe requires an operation name.'), { usage: true });
      const document = await request(resolved, '/openrpc.json', parsed, dependencies);
      const methods =
        isRecord(document.data) && Array.isArray(document.data['methods'])
          ? document.data['methods']
          : [];
      return {
        data:
          methods.find((method) => isRecord(method) && method['name'] === parsed.arguments[1]) ??
          null,
      };
    }
    if (action === 'call' && parsed.arguments[1]) {
      const inputFile = parsed.options.get('input-file') ?? parsed.options.get('file');
      const inputOption = parsed.options.get('input');
      if (inputFile !== undefined && inputOption !== undefined)
        throw makeCliFailure('Use only one of --input and --input-file.', { usage: true });
      if (inputFile === '-' && inputOption === '-')
        throw makeCliFailure('stdin may only be consumed once.', { usage: true });
      const document = await request(resolved, '/openrpc.json', parsed, dependencies);
      const methods =
        isRecord(document.data) && Array.isArray(document.data['methods'])
          ? document.data['methods']
          : [];
      if (!methods.some((method) => isRecord(method) && method['name'] === parsed.arguments[1]))
        throw Object.assign(
          new Error(`Operation is not externally discoverable: ${parsed.arguments[1]}`),
          { usage: true },
        );
      const operation = catalogByName.get(parsed.arguments[1]);
      if (
        operation === undefined ||
        operation.kind !== 'unary' ||
        !operation.transports.jsonRpcHttp
      )
        throw makeCliFailure(
          `Operation is not a supported unary JSON-RPC operation: ${parsed.arguments[1]}.`,
          { usage: true },
        );
      if (operation.destructive && parsed.options.get('yes') !== true)
        throw makeCliFailure(
          `Operation ${parsed.arguments[1]} is destructive; pass --yes to confirm.`,
          { exitCode: 5 },
        );
      const input = inputFile ?? inputOption;
      const inputText =
        input === '-'
          ? await (dependencies.stdin ?? (async () => ''))()
          : input === undefined
            ? undefined
            : await readFile(String(input), 'utf8');
      if (input === '-' && inputText === undefined)
        throw Object.assign(new Error('stdin input is unavailable.'), { usage: true });
      let params: unknown = {};
      try {
        params = inputText === undefined ? {} : JSON.parse(inputText);
      } catch {
        throw makeCliFailure('Input must contain valid JSON.', { usage: true });
      }
      const response = await request(resolved, '/jsonrpc', parsed, dependencies, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: `${Date.now()}`,
          method: parsed.arguments[1],
          params,
        }),
      });
      return isRecord(response.data) && Object.hasOwn(response.data, 'result')
        ? { ...response, data: response.data['result'] }
        : response;
    }
    throw Object.assign(new Error('Usage: api list|describe <operation>|call <operation>.'), {
      usage: true,
    });
  }
  throw Object.assign(new Error(`Unsupported command: ${parsed.command}`), { usage: true });
}

/** Execute one command through the host HTTP APIs. */
export async function executeCli(
  arguments_: readonly string[],
  dependencies: CliClientDependencies = {},
): Promise<CliResult> {
  const parsed = parse(arguments_);
  if ('exitCode' in parsed) return parsed;
  try {
    const result = await execute(parsed, dependencies);
    if (result.metadata?.['error'] !== undefined) {
      const error = result.metadata['error'];
      return {
        stdout: '',
        stderr: typeof error === 'string' ? error : JSON.stringify(error),
        exitCode: 3,
      };
    }
    return {
      stdout:
        result.metadata?.['streamed'] === true && parsed.output === 'text'
          ? ''
          : render(parsed, result),
      stderr: '',
      exitCode: 0,
    };
  } catch (error) {
    const status =
      isRecord(error) && typeof error['status'] === 'number' ? error['status'] : undefined;
    const usageError = isRecord(error) && error['usage'] === true;
    const mutation =
      parsed.command === 'restart' || (parsed.command === 'api' && parsed.arguments[0] === 'call');
    const exitCode: CliExitCode = dependencies.signal?.aborted
      ? 130
      : isRecord(error) && isCliExitCode(error['exitCode'])
        ? error['exitCode']
        : usageError
          ? 2
          : status === 401 || status === 403
            ? 3
            : status === 409
              ? 4
              : status === undefined && error instanceof DOMException && error.name === 'AbortError'
                ? 6
                : mutation
                  ? 7
                  : 1;
    const message = error instanceof Error ? error.message : String(error);
    const renderedFailure = {
      schemaVersion: CLI_SCHEMA_VERSION,
      error: { code: `CLI_${exitCode}`, message, retryable: exitCode === 6 },
      ...(isRecord(error) && isRecord(error['identifiers'])
        ? { identifiers: error['identifiers'] }
        : {}),
    };
    return {
      stdout: parsed.output === 'text' && exitCode !== 5 ? '' : JSON.stringify(renderedFailure),
      stderr: message,
      exitCode,
    };
  }
}

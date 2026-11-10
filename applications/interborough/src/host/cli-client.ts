import { readFile } from 'node:fs/promises';

import { createCatalogSnapshot } from '@lostgradient/weft';

import { executeAssets } from './cli-assets.ts';
import { executeAutomation } from './cli-automation.ts';
import { executeChat, executeReviewsOrRuns } from './cli-chat.ts';
import { executeConnection } from './cli-client-connections.ts';
import { readPreferences } from './cli-client-preferences.ts';
import { request, type CliTarget } from './cli-client-transport.ts';
import { executeConfiguration } from './cli-configuration.ts';
import { executeDefinitions } from './cli-definitions.ts';
import { executeMemory } from './cli-memory.ts';
import { executeAudit, executeRuns } from './cli-runs.ts';
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
  /** Binary payload reserved for explicit asset stdout mode. */
  readonly stdoutBytes?: Uint8Array;
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
  /** Optional interactive prompt used only when the input stream is a TTY. */
  readonly prompt?: (question: string, signal?: AbortSignal) => Promise<string>;
  /** Optional protected prompt used for credentials; implementations must not echo input. */
  readonly promptSecret?: (question: string, signal?: AbortSignal) => Promise<string>;
  /** Whether interactive prompting is supported by the caller. */
  readonly stdinIsTTY?: boolean;
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
  'agents.*',
  'workflows.*',
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
  'attachment',
  'provider',
  'format',
  'status',
  'kind',
  'agent-name',
  'origin',
  'workflow',
  'offset',
  'page-token',
  'run-id',
  'type',
  'principal',
  'since',
  'until',
  'step',
  'if-revision',
  'revision',
  'include-runs',
  'signal-id',
  'occurrence',
  'secret-output',
  'output-file',
  'media-type',
  'content',
  'query',
  'overwrite',
  'secret-file',
  'secret-stdin',
  'no-open',
  'shell',
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
  whoami: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  status: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  doctor: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  open: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  restart: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace', 'yes'],
  api: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
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
    'workspace',
    'agent',
    'message-file',
    'message',
    'thread',
    'run',
    'cursor',
    'attachment',
  ],
  chats: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
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
    'provider',
    'run',
    'task-id',
  ],
  reviews: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
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
    'workspace',
    'task-id',
    'message-id',
    'answer',
    'decision',
    'signal-name',
    'call-id',
    'reason',
    'kind',
    'agent-name',
    'origin',
    'workflow',
    'offset',
    'page-token',
    'limit',
    'cursor',
    'wait',
    'step',
    'status',
  ],
  events: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'kind',
    'cursor',
  ],
  audit: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'run-id',
    'type',
    'principal',
    'since',
    'until',
    'format',
    'cursor',
    'limit',
  ],
  agents: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'file',
    'input',
    'input-file',
    'limit',
    'offset',
    'if-revision',
    'expected-revision',
    'revision',
    'message',
  ],
  workflows: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'file',
    'input',
    'input-file',
    'limit',
    'offset',
    'if-revision',
    'expected-revision',
    'revision',
    'wait',
    'include-runs',
    'signal-name',
    'signal-id',
  ],
  memory: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'agent',
    'query',
    'content',
    'kind',
    'limit',
    'offset',
    'yes',
  ],
  assets: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'file',
    'media-type',
    'output-file',
    'overwrite',
  ],
  schedules: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'file',
    'if-revision',
    'expected-revision',
    'occurrence',
    'limit',
    'offset',
  ],
  goals: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'file',
    'if-revision',
    'expected-revision',
    'limit',
    'offset',
  ],
  hooks: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'file',
    'if-revision',
    'expected-revision',
    'secret-output',
    'limit',
  ],
  providers: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'input',
    'input-file',
    'file',
    'expected-revision',
    'secret-file',
    'secret-stdin',
  ],
  models: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  tools: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  'tool-sources': [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'input',
    'input-file',
    'file',
    'expected-revision',
    'no-open',
  ],
  plugins: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'expected-revision',
  ],
  skills: ['help', 'output', 'no-input', 'connection', 'url', 'timeout', 'workspace'],
  settings: [
    'help',
    'output',
    'no-input',
    'connection',
    'url',
    'timeout',
    'workspace',
    'input',
    'input-file',
    'file',
    'expected-revision',
  ],
  completion: ['help'],
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
  runs: 'Usage: interborough runs <list|get|inspect|watch|cancel> [options]\n\n  --kind task|workflow  Required for get, inspect, watch and cancel; list defaults to task\n  --output jsonl       Emit one typed watch record per line',
  events:
    'Usage: interborough events watch [options]\n\n  --kind task|workflow  Required for watch',
  audit: 'Usage: interborough audit list [options]',
  agents:
    'Usage: interborough agents <list|get|create|update|delete|duplicate|models|versions|try> [options]',
  workflows:
    'Usage: interborough workflows <list|get|create|update|validate|start|signal|history> [options]',
  memory: 'Usage: interborough memory <list|search|get|remember|correct|forget|export> [options]',
  assets: 'Usage: interborough assets <upload|download> [options]',
  schedules:
    'Usage: interborough schedules <list|get|create|update|pause|resume|run|skip-next> [options]',
  goals: 'Usage: interborough goals <list|get|create|cancel> [options]',
  hooks:
    'Usage: interborough hooks <list|get|create|update|replace-secret|delete|test|deliveries> [options]',
  providers: 'Usage: interborough providers <list|connect|disconnect> [provider] [options]',
  models: 'Usage: interborough models list [options]',
  tools: 'Usage: interborough tools list [options]',
  'tool-sources':
    'Usage: interborough tool-sources <list|add|update|probe|authorize|remove> [id] [options]',
  plugins: 'Usage: interborough plugins <list|enable|disable> [plugin] [options]',
  skills: 'Usage: interborough skills list [options]',
  settings: 'Usage: interborough settings <get|set|schema> [options]',
  completion: 'Usage: interborough completion <bash|zsh|fish>',
};

/** The shell-facing metadata for every public command in the installed CLI. */
export const CLI_COMMAND_REGISTRY = Object.freeze(
  Object.fromEntries(
    Object.entries(commandOptions).map(([command, options]) => [
      command,
      Object.freeze({
        command,
        options: Object.freeze([...options]),
        help: helpText[command] ?? `Usage: interborough ${command} [options]`,
      }),
    ]),
  ),
) as Readonly<
  Record<
    string,
    { readonly command: string; readonly options: readonly string[]; readonly help: string }
  >
>;

/** Render completion source from the same registry used to validate CLI options. */
export function renderCliCompletion(shell: 'bash' | 'zsh' | 'fish'): string {
  const commands = Object.keys(CLI_COMMAND_REGISTRY).sort();
  const optionsFor = (command: string) =>
    CLI_COMMAND_REGISTRY[command]!.options.map((option) => `--${option}`).join(' ');
  if (shell === 'fish')
    return [
      `complete -c interborough -f -a '${commands.join(' ')}'`,
      ...commands.map(
        (command) =>
          `complete -c interborough -n '__fish_seen_subcommand_from ${command}' -l ${CLI_COMMAND_REGISTRY[command]!.options.join(' -l ')}`,
      ),
    ].join('\n');
  if (shell === 'zsh')
    return [
      '#compdef interborough',
      '_interborough_completion() {',
      '  case "$words[2]" in',
      ...commands.map(
        (command) => `    ${command}) _arguments '*:option:(${optionsFor(command)})' ;;`,
      ),
      `    *) _arguments '1:command:(${commands.join(' ')})' ;;`,
      '  esac',
      '}',
      'compdef _interborough_completion interborough',
    ].join('\n');
  return [
    '_interborough_complete() {',
    '  local command="${COMP_WORDS[1]}"',
    '  case "$command" in',
    ...commands.map(
      (command) =>
        `    ${command}) COMPREPLY=( $(compgen -W '${optionsFor(command)}' -- "\${COMP_WORDS[COMP_CWORD]}") ) ;;`,
    ),
    `    *) COMPREPLY=( $(compgen -W '${commands.join(' ')}' -- "\${COMP_WORDS[COMP_CWORD]}") ) ;;`,
    '  esac',
    '}',
    'complete -F _interborough_complete interborough',
  ].join('\n');
}

const catalogByName = new Map(
  createCatalogSnapshot().operations.map((operation) => [operation.name, operation]),
);

/** Exhaustive mapping from the engine catalog to a public CLI action or an explicit exclusion. */
export const CLI_OPERATION_COVERAGE = Object.freeze(
  Object.fromEntries(
    createCatalogSnapshot().operations.map((operation) => [
      operation.name,
      operation.transports.jsonRpcHttp && operation.kind === 'unary'
        ? { command: 'api', action: 'call' }
        : {
            excluded: true,
            reason: 'The operation has no unary JSON-RPC-over-HTTP transport exposed by the CLI.',
          },
    ]),
  ),
) as Readonly<
  Record<
    string,
    | { readonly command: string; readonly action: string }
    | { readonly excluded: true; readonly reason: string }
  >
>;

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
    const booleanOption =
      ['all', 'help', 'no-input', 'yes', 'overwrite', 'secret-stdin', 'no-open'].includes(name) ||
      ((name === 'wait' || name === 'include-runs') && command === 'workflows');
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
  if (
    outputValue === 'jsonl' &&
    command !== 'api' &&
    command !== 'chat' &&
    command !== 'runs' &&
    command !== 'events'
  )
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

function remoteUrl(raw: string): URL | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' && url.username === '' && url.password === ''
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function authorityFrom(value: unknown): CliTarget['authority'] | undefined {
  if (!isRecord(value)) return undefined;
  const result = isRecord(value['result']) ? value['result'] : value;
  const workspace = isRecord(result['workspace']) ? result['workspace'] : undefined;
  if (
    workspace === undefined ||
    typeof workspace['actorId'] !== 'string' ||
    typeof workspace['workspaceId'] !== 'string' ||
    !Array.isArray(workspace['capabilities']) ||
    workspace['capabilities'].some((capability) => typeof capability !== 'string')
  )
    return undefined;
  return {
    actor: workspace['actorId'],
    workspace: workspace['workspaceId'],
    capabilities: workspace['capabilities'],
  };
}

async function resolveTarget(
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliTarget | CliResult> {
  const environment = { ...dependencies.environment };
  const preferences = await readPreferences(dependencies);
  const connection =
    parsed.connection === undefined
      ? preferences.connections.find((entry) => entry.name === preferences.activeConnection)
      : preferences.connections.find((entry) => entry.name === parsed.connection);
  if (parsed.connection !== undefined && connection === undefined)
    return { stdout: '', stderr: `Unknown connection: ${parsed.connection}.`, exitCode: 1 };
  if (
    parsed.url !== undefined &&
    connection?.credentialReference !== undefined &&
    parsed.url.replace(/\/$/, '') !== connection.url.replace(/\/$/, '')
  )
    return {
      stdout: '',
      stderr: 'An explicit --url cannot override a saved connection credential for another host.',
      exitCode: 1,
    };
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
  const local = loopbackUrl(raw);
  const remote = remoteUrl(raw);
  if (local === undefined && remote === undefined)
    return {
      stdout: '',
      stderr:
        'Management endpoints must be loopback HTTP or non-loopback HTTPS with --credential-reference.',
      exitCode: 3,
    };
  if (remote !== undefined && connection?.credentialReference === undefined)
    return {
      stdout: '',
      stderr: 'Non-loopback management endpoints require --credential-reference.',
      exitCode: 3,
    };
  const target: CliTarget = {
    url: raw.replace(/\/$/, ''),
    headers:
      credential === undefined
        ? {}
        : remote === undefined
          ? { authorization: `Bearer ${credential}` }
          : { 'x-api-key': credential },
    ...(remote === undefined ? {} : { remote: true }),
  };
  if (remote === undefined) return target;
  const authorityResponse = await request(target, '/api/v1/principal', parsed, dependencies);
  const authority = authorityFrom(authorityResponse.data);
  if (authority === undefined)
    throw makeCliFailure('The management server returned no workspace authority.', { exitCode: 3 });
  const expectedWorkspace = parsed.options.get('workspace');
  if (typeof expectedWorkspace === 'string' && expectedWorkspace !== authority.workspace)
    throw makeCliFailure('The authenticated workspace does not match --workspace.', {
      status: 403,
    });
  return { ...target, authority };
}

function envelope(result: CliCommandResult): Record<string, unknown> {
  return { schemaVersion: CLI_SCHEMA_VERSION, data: result.data, metadata: result.metadata ?? {} };
}

function render(parsed: Parsed, result: CliCommandResult): string {
  const value = envelope(result);
  if (parsed.output === 'jsonl' && isRecord(result.data) && Array.isArray(result.data['events']))
    return result.data['events'].map((event) => JSON.stringify(event)).join('\n');
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

function targetResolutionFailure(result: CliResult): CliCommandResult {
  if (result.exitCode === 1) throw Object.assign(new Error(result.stderr), result);
  return { data: undefined, metadata: { error: result.stderr } };
}

async function execute(
  parsed: Parsed,
  dependencies: CliClientDependencies,
): Promise<CliCommandResult> {
  if (parsed.command === 'completion') {
    const shell = parsed.arguments[0];
    if (shell !== 'bash' && shell !== 'zsh' && shell !== 'fish')
      throw Object.assign(new Error('completion requires bash, zsh, or fish.'), { usage: true });
    return { data: renderCliCompletion(shell) };
  }
  if (parsed.command === 'connection')
    return executeConnection(
      parsed,
      dependencies,
      (value) => loopbackUrl(value) ?? remoteUrl(value),
    );
  const resolved = await resolveTarget(parsed, dependencies);
  if ('exitCode' in resolved) return targetResolutionFailure(resolved);
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
  if (parsed.command === 'reviews' || parsed.command === 'runs' || parsed.command === 'events')
    return parsed.command === 'runs' || parsed.command === 'events'
      ? executeRuns(resolved, parsed, dependencies)
      : executeReviewsOrRuns(resolved, parsed, dependencies);
  if (parsed.command === 'audit') return executeAudit(resolved, parsed, dependencies);
  if (parsed.command === 'agents' || parsed.command === 'workflows')
    return executeDefinitions(resolved, parsed, dependencies);
  if (parsed.command === 'memory') return executeMemory(resolved, parsed, dependencies);
  if (parsed.command === 'assets') return executeAssets(resolved, parsed, dependencies);
  if (parsed.command === 'schedules' || parsed.command === 'goals' || parsed.command === 'hooks')
    return executeAutomation(resolved, parsed, dependencies);
  if (
    ['providers', 'models', 'tools', 'tool-sources', 'plugins', 'skills', 'settings'].includes(
      parsed.command,
    )
  )
    return executeConfiguration(resolved, parsed, dependencies);
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
    return resolved.authority === undefined
      ? { data: { actor: 'anonymous:local', workspace: null, capabilities: ['local-loopback'] } }
      : { data: resolved.authority };
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
        result.metadata?.['binaryStdout'] instanceof Uint8Array
          ? ''
          : result.metadata?.['streamed'] === true &&
              (parsed.output === 'text' || parsed.output === 'jsonl')
            ? ''
            : render(parsed, result),
      stderr: '',
      exitCode: 0,
      ...(result.metadata?.['binaryStdout'] instanceof Uint8Array
        ? { stdoutBytes: result.metadata['binaryStdout'] }
        : {}),
    };
  } catch (error) {
    const status =
      isRecord(error) && typeof error['status'] === 'number' ? error['status'] : undefined;
    const usageError = isRecord(error) && error['usage'] === true;
    const mutation =
      parsed.command === 'restart' ||
      (parsed.command === 'memory' &&
        ['remember', 'correct', 'forget'].includes(parsed.arguments[0] ?? '')) ||
      (parsed.command === 'assets' && parsed.arguments[0] === 'upload') ||
      (parsed.command === 'api' && parsed.arguments[0] === 'call') ||
      (['providers', 'tool-sources', 'plugins', 'settings'].includes(parsed.command) &&
        [
          'connect',
          'disconnect',
          'add',
          'update',
          'probe',
          'authorize',
          'remove',
          'enable',
          'disable',
          'set',
        ].includes(parsed.arguments[0] ?? '')) ||
      (parsed.command === 'runs' && parsed.arguments[0] === 'cancel') ||
      (['schedules', 'goals', 'hooks'].includes(parsed.command) &&
        [
          'create',
          'update',
          'pause',
          'resume',
          'run',
          'skip-next',
          'cancel',
          'replace-secret',
          'delete',
          'test',
        ].includes(parsed.arguments[0] ?? ''));
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
      stdout:
        parsed.output === 'text' && exitCode !== 5 && exitCode !== 130
          ? ''
          : JSON.stringify(renderedFailure),
      stderr: message,
      exitCode,
    };
  }
}

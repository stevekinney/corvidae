import { accessSync, constants, existsSync, lstatSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';

import type { BungalowEnvironment } from '@lostgradient/bungalow';
import { environmentalist } from '@lostgradient/environmentalist';
import type { Source } from '@lostgradient/environmentalist/types';
import { z } from 'zod';

import { executeCli } from './cli-client.ts';
import {
  A2A_PUBLIC_ORIGIN_VARIABLE,
  BUILD_DIRECTORY_VARIABLE,
  DEFAULT_PORT,
  PORT_VARIABLE,
  processEnvironment,
  resolveA2aPublicOrigin,
  resolvePort,
} from './environment-configuration.ts';
import { PLUGIN_RUNTIME_DIRECTORY_VARIABLE } from './folder-plugins.ts';
import { launchCommandEnvironment, shellQuote } from './launch-command.ts';
import { PANEL_PREBUILT_DIRECTORY_VARIABLE } from './panel-mounts.ts';
import { serveHost } from './serve.ts';
import { supervise } from './supervisor.ts';

// The release build defines this identifier to a JSON string containing its semver.
declare const INTERBOROUGH_RELEASE_VERSION: string;

const HOME_VARIABLE = 'INTERBOROUGH_HOME';
const INTERNAL_HOST_COMMAND = '__interborough-host';

/** The plugin runtime directory relative to a relocated compiled executable. */
export function pluginRuntimeDirectory(executable: string): string {
  return join(dirname(executable), '..', 'share', 'interborough', 'plugin-runtime', 'node_modules');
}

const HELP = `Usage: interborough start [options]

  --port <port>                 Listen on 127.0.0.1 (default: 7234, 0 for a free port)
  --home <directory>            State directory (default: ~/.interborough)
  --a2a-public-origin <origin>  HTTPS origin for A2A behind a reverse proxy
  --help                        Show this help
  --version                     Show the release version`;

function configurationSource(id: string, values: Record<string, string | undefined>): Source {
  const read = () => ({
    location: id,
    values: Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined)),
  });
  return { id, kind: 'string', load: read, loadSync: read };
}

function resolveHome(home: string, cwd: string): string {
  if (home.trim() === '')
    throw new Error('The Interborough home must be a nonempty directory path.');
  const path = resolve(cwd, home);
  let ancestor = path;
  try {
    for (;;) {
      try {
        lstatSync(ancestor);
        break;
      } catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
        ancestor = dirname(ancestor);
      }
    }
    if (!statSync(ancestor).isDirectory()) throw new Error('Expected a directory.');
    accessSync(ancestor, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(
      `The Interborough home must be a writable directory or creatable path: ${path}`,
    );
  }
  return path;
}

function startEnvironment(arguments_: string[], cwd: string) {
  const { values, tokens } = parseArgs({
    args: arguments_,
    options: {
      port: { type: 'string' },
      home: { type: 'string' },
      'a2a-public-origin': { type: 'string' },
      help: { type: 'boolean' },
      version: { type: 'boolean' },
    },
    tokens: true,
  });
  const seen = new Set<string>();
  for (const token of tokens) {
    if (token.kind !== 'option') continue;
    if (seen.has(token.name)) throw new Error(`Duplicate option --${token.name}.`);
    seen.add(token.name);
  }
  if (values.help) return { output: HELP };
  if (values.version) return { output: INTERBOROUGH_RELEASE_VERSION };

  const exported = processEnvironment();
  const settings = environmentalist.sync({
    name: 'interborough',
    schema: z.object({
      port: z.string().min(1).default(String(DEFAULT_PORT)),
      home: z.string().optional(),
      a2aPublicOrigin: z.string().min(1).optional(),
    }),
    argv: [],
    coerce: false,
    sources: [
      configurationSource('start-options', {
        port: values.port,
        home: values.home,
        a2aPublicOrigin: values['a2a-public-origin'],
      }),
      configurationSource('exported-environment', {
        port: exported[PORT_VARIABLE] || undefined,
        home: exported[HOME_VARIABLE] || undefined,
        a2aPublicOrigin: exported[A2A_PUBLIC_ORIGIN_VARIABLE] || undefined,
      }),
      'defaults',
    ],
  });
  const environment: BungalowEnvironment = {
    ...exported,
    [PORT_VARIABLE]: settings.port,
    [HOME_VARIABLE]: settings.home === undefined ? undefined : resolveHome(settings.home, cwd),
    [A2A_PUBLIC_ORIGIN_VARIABLE]: settings.a2aPublicOrigin,
  };
  resolvePort(environment);
  resolveA2aPublicOrigin(environment);
  return { environment };
}

async function run(arguments_: string[]): Promise<number> {
  const [command, ...options] = arguments_;
  if (command === INTERNAL_HOST_COMMAND && options.length === 0) {
    const environment = processEnvironment();
    const buildDirectory = environment[BUILD_DIRECTORY_VARIABLE];
    if (buildDirectory === undefined)
      throw new Error('The supervisor must supply the build directory.');
    await serveHost(environment, buildDirectory);
    return 0;
  }
  if (command !== 'start' && command !== '--help' && command !== '--version') {
    const interrupt = new AbortController();
    const onInterrupt = () => interrupt.abort();
    process.once('SIGINT', onInterrupt);
    const result = await executeCli(arguments_, {
      environment: processEnvironment(),
      ...(process.stdin.isTTY ? {} : { stdin: () => Bun.stdin.text() }),
      writeStdout: (chunk) => process.stdout.write(chunk),
      stdinIsTTY: process.stdin.isTTY,
      signal: interrupt.signal,
      prompt: async (question, signal) => {
        const readline = createInterface({ input: process.stdin, output: process.stderr });
        readline.on('SIGINT', onInterrupt);
        try {
          return await readline.question(question, { signal });
        } finally {
          readline.close();
        }
      },
      promptSecret: async (question, signal) => {
        if (!process.stdin.isTTY || process.stdin.setRawMode === undefined)
          throw new Error('A protected secret prompt requires a TTY.');
        process.stderr.write(question);
        process.stdin.setRawMode(true);
        process.stdin.resume();
        return await new Promise<string>((complete, reject) => {
          let answer = '';
          const onAbort = () => finish(new DOMException('Aborted', 'AbortError'));
          const onData = (chunk: Buffer) => {
            for (const byte of chunk) {
              if (byte === 3) return finish(new DOMException('Aborted', 'AbortError'));
              if (byte === 13 || byte === 10) return finish();
              if (byte === 127) answer = answer.slice(0, -1);
              else answer += String.fromCharCode(byte);
            }
          };
          const finish = (error?: Error) => {
            process.stdin.setRawMode?.(false);
            process.stdin.pause();
            process.stdin.off('data', onData);
            signal?.removeEventListener('abort', onAbort);
            if (error === undefined) {
              process.stderr.write('\n');
              complete(answer);
            } else reject(error);
          };
          process.stdin.on('data', onData);
          signal?.addEventListener('abort', onAbort, { once: true });
        });
      },
    });
    process.removeListener('SIGINT', onInterrupt);
    if (result.stdoutBytes !== undefined) process.stdout.write(result.stdoutBytes);
    else if (result.stdout !== '') process.stdout.write(`${result.stdout}\n`);
    if (result.stderr !== '') console.error(result.stderr);
    return result.exitCode;
  }
  const cwd = process.cwd();
  let result: ReturnType<typeof startEnvironment>;
  try {
    if (command === 'start') result = startEnvironment(options, cwd);
    else if (command === '--help' && options.length === 0) result = { output: HELP };
    else if (command === '--version' && options.length === 0) {
      result = { output: INTERBOROUGH_RELEASE_VERSION };
    } else throw new Error('Expected interborough start, --help, or --version.');
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }
  if (result.environment === undefined) {
    console.info(result.output);
    return 0;
  }
  const executable = realpathSync(process.execPath);
  const buildOverride = result.environment[BUILD_DIRECTORY_VARIABLE];
  const buildDirectory = buildOverride
    ? resolve(cwd, buildOverride)
    : join(dirname(executable), '..', 'share', 'interborough', 'browser');
  return supervise({
    command: [executable, INTERNAL_HOST_COMMAND],
    cwd,
    environment: {
      ...result.environment,
      [BUILD_DIRECTORY_VARIABLE]: buildDirectory,
      [PLUGIN_RUNTIME_DIRECTORY_VARIABLE]: pluginRuntimeDirectory(executable),
      [PANEL_PREBUILT_DIRECTORY_VARIABLE]: join(
        dirname(executable),
        '..',
        'share',
        'interborough',
        'panels',
      ),
      ...launchCommandEnvironment({
        command: [executable, ...arguments_].map(shellQuote).join(' '),
        directory: cwd,
      }),
    },
    prepare: () => {
      const page = join(buildDirectory, 'index.html');
      return existsSync(page) ? undefined : `Interborough browser assets are missing: ${page}`;
    },
  });
}

if (import.meta.main) process.exitCode = await run(process.argv.slice(2));

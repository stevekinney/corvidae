#!/usr/bin/env bun
// Chef repository packets: one compact packet per area at `<main checkout>/tmp/chef/packets/<area>.md`
// (gitignored), written by the coordinator before dispatching, so a worker reads the packet instead
// of rediscovering the code. A packet holds the exact paths, the signatures and line numbers that
// matter, the commands, and the rules already settled. The worker reads source only for the lines
// it will change; the coordinator updates the packet when a merge changes what it describes.
//
// Usage:
//   bun scripts/chef/packet.ts new <area> [--path <file>]... [--dir <packets directory>]
//   bun scripts/chef/packet.ts status <area> [--config <json>] [--dir <dir>] [--json]
//
// `new` writes a skeleton whose header records `Base: <sha>` (HEAD of `origin/<default>` after a
// fetch) and `Written: <ISO time>`, with the `--path` files under "## Paths"; it refuses to
// overwrite a packet. Fill the rest by hand. `status` prints the packet's age and the commits on
// `origin/<default>` since its base that touched its paths (the code spans under "## Paths" that
// look like paths, line suffixes dropped), so a stale packet is easy to spot. A packet with no
// `Base:` line uses its `Written:` time, then its file time.
//
// Exit codes: 0 fresh (no commit touched its paths) or created, 1 stale or packet missing,
// 2 invalid CLI usage.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathsIn, sectionOf } from './brief.ts';
import {
  defaultRunner,
  emitResult,
  parseOptions,
  type Runner,
  UsageError,
} from './process-runner.ts';
import { DEFAULT_CONFIGURATION_PATH, loadRepositoryConfig } from './repository-config.ts';
import { resolveMainCheckout } from './repository-locations.ts';

export { UsageError };

export interface PacketStatus {
  area: string;
  file: string;
  base: string | undefined;
  written: string;
  ageHours: number;
  paths: string[];
  commits: string[];
  stale: boolean;
}

function checkArea(area: string | undefined): string {
  if (area === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(area))
    throw new UsageError('<area> is a plain name: letters, digits, dot, dash, underscore.');
  return area;
}

export function packetFile(directory: string, area: string): string {
  return join(directory, `${area}.md`);
}

export function newPacket(
  runner: Runner,
  directory: string,
  area: string,
  paths: string[],
  defaultBranch: string,
  now = new Date(),
): string {
  const file = packetFile(directory, area);
  if (existsSync(file)) throw new UsageError(`${file} exists; edit it instead.`);
  runner(['git', 'fetch', 'origin', defaultBranch]);
  const base = runner(['git', 'rev-parse', `origin/${defaultBranch}`]).stdout.trim();
  mkdirSync(directory, { recursive: true });
  writeFileSync(
    file,
    [
      `# Packet: ${area}`,
      '',
      `Base: ${base || 'unknown'}`,
      `Written: ${now.toISOString()}`,
      '',
      '## Paths',
      '',
      ...(paths.length > 0 ? paths.map((path) => `- \`${path}\``) : ['- `path/to/file.ts`']),
      '',
      '## Signatures and lines',
      '',
      '## Commands',
      '',
      '## Settled rules',
      '',
    ].join('\n'),
  );
  return file;
}

/** The packet's age and the commits on `origin/<defaultBranch>` that touched its paths since it was written. */
export function packetStatus(
  runner: Runner,
  directory: string,
  area: string,
  defaultBranch: string,
  now = new Date(),
): PacketStatus {
  const file = packetFile(directory, area);
  if (!existsSync(file)) throw new UsageError(`No such packet: ${file}`);
  const text = readFileSync(file, 'utf8');
  const base = /^Base:\s*([0-9a-f]{7,40})\s*$/m.exec(text)?.[1];
  const writtenText = /^Written:\s*(\S+)\s*$/m.exec(text)?.[1];
  const parsed = writtenText === undefined ? Number.NaN : Date.parse(writtenText);
  const written = Number.isFinite(parsed) ? new Date(parsed) : statSync(file).mtime;
  const paths = pathsIn(sectionOf(text, /^paths$/i) ?? '');
  let commits: string[] = [];
  if (paths.length > 0) {
    const range =
      base !== undefined
        ? [`${base}..origin/${defaultBranch}`]
        : [`--since=${written.toISOString()}`, `origin/${defaultBranch}`];
    const log = runner([
      'git',
      'log',
      '--first-parent',
      '--format=%h %s',
      ...range,
      '--',
      ...paths,
    ]);
    commits = log.stdout.split('\n').filter((line) => line.trim() !== '');
  }
  return {
    area,
    file,
    base,
    written: written.toISOString(),
    ageHours: (now.getTime() - written.getTime()) / 3_600_000,
    paths,
    commits,
    stale: commits.length > 0,
  };
}

export function renderStatus(status: PacketStatus): string {
  return [
    `${status.area}: written ${status.written} (${status.ageHours.toFixed(1)} h ago), ${status.paths.length} path(s), ${status.stale ? `STALE: ${status.commits.length} commit(s) touched them` : 'fresh'}`,
    ...status.commits.slice(0, 20).map((commit) => `  ${commit}`),
  ].join('\n');
}

export function run(
  argv: string[],
  runner: Runner = defaultRunner,
): { code: number; output: string } {
  const parsed = parseOptions(argv, {
    values: ['config', 'dir'],
    repeated: ['path'],
    flags: ['json'],
  });
  const [command, area, ...extra] = parsed.positionals;
  if ((command !== 'new' && command !== 'status') || extra.length > 0)
    throw new UsageError(
      'Usage: packet.ts new|status <area> [--path <file>]... [--dir <dir>] [--json]',
    );
  const name = checkArea(area);
  const config = loadRepositoryConfig(parsed.values['config'] ?? DEFAULT_CONFIGURATION_PATH);
  const directory =
    parsed.values['dir'] ?? join(resolveMainCheckout(runner), 'tmp', 'chef', 'packets');
  if (command === 'new') {
    const file = newPacket(
      runner,
      directory,
      name,
      parsed.repeated['path'] ?? [],
      config.defaultBranch,
    );
    return { code: 0, output: `Packet skeleton written to ${file}.` };
  }
  runner(['git', 'fetch', 'origin', config.defaultBranch]);
  const status = packetStatus(runner, directory, name, config.defaultBranch);
  return {
    code: status.stale ? 1 : 0,
    output: parsed.flags.has('json') ? JSON.stringify(status) : renderStatus(status),
  };
}

if (import.meta.main) {
  try {
    const { code, output } = run(Bun.argv.slice(2));
    emitResult(Bun.argv.slice(2), { code, output });
    process.exitCode = code;
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 2;
  }
}

// Shared scaffolding of the session-fence hook tests: a places directory and a main checkout in a
// scratch directory, a hook context over them, a lease marker, and a Claude Code transcript.

import { afterAll } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { HookContext } from '../host-sessions.ts';
import { stateDirectoryOf } from './report.ts';

const roots: string[] = [];

afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

export type World = {
  places: string;
  main: string;
  state: string;
  briefs: string;
  root: string;
};

/** A places directory, and a main checkout holding the coordinator's state and briefs. */
export async function world(): Promise<World> {
  const root = await mkdtemp(join(tmpdir(), 'corvidae-session-fences-'));
  roots.push(root);
  const main = join(root, 'main');
  const briefs = join(main, 'tmp', 'chef', 'briefs');
  await mkdir(briefs, { recursive: true });
  return { root, places: join(root, 'places'), main, state: stateDirectoryOf(main), briefs };
}

export function context(setting: World, overrides: Partial<HookContext> = {}): HookContext {
  return {
    directory: setting.places,
    hookPid: 411,
    environment: {},
    readProcessTable: () => undefined,
    now: () => 1_000_000,
    sleep: async () => {},
    chef: { stateDirectory: setting.state, briefsDirectory: setting.briefs },
    ...overrides,
  };
}

export async function lease(setting: World, sessionId: string, expiresAt = '2999-01-01T00:00:00Z') {
  await mkdir(join(setting.places, 'leases'), { recursive: true });
  await writeFile(
    join(setting.places, 'leases', `${sessionId}.json`),
    JSON.stringify({
      sessionId,
      project: 'P',
      run: 'run-1',
      leasedAt: '2026-11-19T00:00:00Z',
      expiresAt,
    }),
  );
}

/** A Claude Code transcript whose model calls each held the given number of context tokens. */
export async function transcript(
  setting: World,
  name: string,
  contexts: number[],
): Promise<string> {
  const path = join(setting.root, `${name}.jsonl`);
  const lines = contexts.map((tokens, index) =>
    JSON.stringify({
      type: 'assistant',
      timestamp: `2026-11-19T00:00:${String(index).padStart(2, '0')}Z`,
      message: {
        id: `m${index}`,
        model: 'claude-opus-4-8',
        usage: {
          input_tokens: 10,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: tokens - 10,
          output_tokens: 5,
        },
        content: [{ type: 'text', text: 'ok' }],
      },
    }),
  );
  await writeFile(path, `${lines.join('\n')}\n`);
  return path;
}

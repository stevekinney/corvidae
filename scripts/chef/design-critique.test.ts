import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { run } from './design-critique.ts';
import type { FetchLike } from './linear.ts';

const description = [
  '## Acceptance criteria',
  '- [ ] 11a: Runs reads as cards below 700px (board Runs).',
  '',
  '## Design source',
  'Prototypes: [canvas](https://claude.ai/artifact/GDeC387KnFkpSQoLz86jLw). Index rows:',
  '* **11a** (Runs): Runs list as cards',
].join('\n');

const fetcher: FetchLike = async () =>
  new Response(
    JSON.stringify({
      data: {
        issue: {
          id: 'u1',
          identifier: 'COR-7',
          title: 'Runs list',
          description,
          updatedAt: '2026-11-19T00:00:00Z',
          state: { id: 's', name: 'Todo' },
          team: { id: 't', key: 'COR', parent: null },
        },
      },
    }),
    { status: 200 },
  );
const dependencies = { fetch: fetcher, environment: { LINEAR_API_KEY: 'lin_api_test_value' } };

let sandbox: string;
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'design-critique-'));
});
afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

const critique = (overrides: Record<string, unknown> = {}) => ({
  rows: [
    {
      id: '11a',
      board: 'Runs',
      text: 'Runs as cards',
      states: [
        { route: '/runs', state: 'ready', kind: 'ready' },
        { route: '/runs', state: 'empty', kind: 'empty' },
      ],
    },
  ],
  checked: [{ literal: '700px', result: 'consistent' }],
  conflicts: [],
  ...overrides,
});

function input(value: unknown): string {
  const path = join(sandbox, 'critique.json');
  writeFileSync(path, JSON.stringify(value));
  return path;
}

describe('design-critique rows', () => {
  test('prints the design rows and literal criteria the critique checks', async () => {
    const result = await run(['rows', 'COR-7'], dependencies);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.output) as { rowIds: string[]; literals: string[] };
    expect(parsed.rowIds).toEqual(['11a']);
    expect(parsed.literals).toEqual(['700px']);
  });
});

describe('design-critique write', () => {
  test('writes rows.resolved.json for a valid critique, which brief.ts then accepts', async () => {
    const result = await run(
      ['write', 'COR-7', '--input', input(critique()), '--out-dir', sandbox],
      dependencies,
    );
    expect(result.code).toBe(0);
    const file = JSON.parse(readFileSync(join(sandbox, 'COR-7', 'rows.resolved.json'), 'utf8'));
    expect(file).toMatchObject({ version: 1, issue: 'COR-7' });
  });

  test('refuses a critique with a row that declares no states, writing nothing', async () => {
    const bad = critique({ rows: [{ id: '11a', board: 'Runs', text: 'x', states: [] }] });
    const result = await run(
      ['write', 'COR-7', '--input', input(bad), '--out-dir', sandbox],
      dependencies,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('row 11a declares no states');
    expect(existsSync(join(sandbox, 'COR-7', 'rows.resolved.json'))).toBe(false);
  });

  test('refuses a critique that skipped the 700px criterion', async () => {
    const result = await run(
      ['write', 'COR-7', '--input', input(critique({ checked: [] })), '--out-dir', sandbox],
      dependencies,
    );
    expect(result.code).toBe(1);
    expect(result.output).toContain('literal criterion 700px was not checked');
  });

  test('refuses a file that is not JSON and bad usage', async () => {
    const path = join(sandbox, 'bad.json');
    writeFileSync(path, '{');
    expect(
      (await run(['write', 'COR-7', '--input', path, '--out-dir', sandbox], dependencies)).code,
    ).toBe(1);
    await expect(run(['write', 'COR-7'], dependencies)).rejects.toThrow('--input is required');
    await expect(run(['rows'], dependencies)).rejects.toThrow('Usage');
  });
});

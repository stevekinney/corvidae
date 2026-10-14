import { describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { isCliEntrypoint, runCli as runKnowledgeCli } from './index.ts';

const cliDirectory = dirname(fileURLToPath(import.meta.url));
const cliEntrypoint = join(cliDirectory, 'index.ts');

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
};

async function runCli(args: string[]): Promise<CliResult> {
  let stdout = '';
  let stderr = '';
  const exitCode = await runKnowledgeCli(args, {
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
  });
  return { exitCode, stdout, stderr };
}

function parseJson(stdout: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(stdout);
  if (!isRecord(parsed)) throw new Error('CLI JSON output must be an object.');
  return parsed;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

describe('cinder CLI', () => {
  it('prints help without writing stderr', async () => {
    const result = await runCli(['--help']);

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(result.stdout).toContain('bun run knowledge search <query>');
    expect(result.stdout).not.toContain('cinder mcp');
  });

  it('rejects the removed mcp command with suggestions that exclude it', async () => {
    const result = await runCli(['mcp', '--json']);
    const payload = parseJson(result.stdout);
    const error = payload['error'];

    expect(result.exitCode).toBe(1);
    expect(isRecord(error) && error['code']).toBe('UNKNOWN_COMMAND');
    expect(isRecord(error) && error['suggestions']).toEqual([
      'list',
      'search',
      'show',
      'compare',
      'best-practices',
    ]);
  });

  it('prints search results in the JSON envelope', async () => {
    const result = await runCli(['search', 'modal', '--json']);
    const payload = parseJson(result.stdout);
    const data = payload['data'];

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload['command']).toBe('search');
    expect(isRecord(payload['package']) && payload['package']['name']).toBe('@lostgradient/cinder');
    expect(Array.isArray(data)).toBe(true);
    expect(
      Array.isArray(data) &&
        data.some((component: unknown) => isRecord(component) && component['id'] === 'modal'),
    ).toBe(true);
  });

  it('prints component details in the JSON envelope', async () => {
    const result = await runCli(['show', 'button', '--json']);
    const payload = parseJson(result.stdout);
    const data = payload['data'];

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload['command']).toBe('show');
    expect(isRecord(data)).toBe(true);
    expect(isRecord(data) && isRecord(data['component']) && data['component']['id']).toBe('button');
    expect(isRecord(data) && data['schema']).toBeDefined();
    expect(isRecord(data) && data['variables']).toBeDefined();
  });

  it('prints best-practice payloads in the JSON envelope', async () => {
    const result = await runCli(['best-practices', 'styles', '--json']);
    const payload = parseJson(result.stdout);
    const data = payload['data'];

    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toBe('');
    expect(payload['command']).toBe('best-practices');
    expect(Array.isArray(data)).toBe(true);
    const firstSection: unknown = Array.isArray(data) ? data[0] : undefined;
    expect(isRecord(firstSection) ? firstSection['topic'] : undefined).toBe('styles');
  });

  it('prints JSON-mode failures to stdout with no stderr noise', async () => {
    const result = await runCli(['show', 'buton', '--json']);
    const payload = parseJson(result.stdout);
    const error = payload['error'];

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(isRecord(error)).toBe(true);
    expect(isRecord(error) && error['code']).toBe('COMPONENT_NOT_FOUND');
    expect(isRecord(error) && Array.isArray(error['suggestions'])).toBe(true);
  });

  it('rejects non-numeric limit suffixes', async () => {
    const result = await runCli(['search', 'button', '--limit', '10abc', '--json']);
    const payload = parseJson(result.stdout);
    const error = payload['error'];

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('');
    expect(isRecord(error) && error['code']).toBe('BAD_LIMIT');
  });

  it('detects direct and symlinked Node bin entrypoints without import.meta.main', () => {
    const moduleUrl = pathToFileURL(cliEntrypoint).href;
    const temporaryDirectory = mkdtempSync(join(tmpdir(), 'cinder-cli-'));
    const symlinkPath = join(temporaryDirectory, 'cinder');
    symlinkSync(cliEntrypoint, symlinkPath);

    try {
      expect(isCliEntrypoint(cliEntrypoint, moduleUrl)).toBe(true);
      expect(isCliEntrypoint(symlinkPath, moduleUrl)).toBe(true);
      expect(isCliEntrypoint(join(temporaryDirectory, 'missing'), moduleUrl)).toBe(false);
    } finally {
      rmSync(temporaryDirectory, { recursive: true, force: true });
    }
  });
});

import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { unexpectedChildStderr } from './child-stderr';

const holdLine = (runId: string) =>
  `[bureau] Run "${runId}" reached recovery before the bureau finished composing; holding it until composition completes.\n`;
const resolverHoldLine = (runId?: string) =>
  `[bureau] ${runId === undefined || runId === '' ? 'A run' : `Run "${runId}"`} needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog.\n`;

describe('unexpectedChildStderr', () => {
  it('drops every composition-hold line and nothing else', () => {
    expect(unexpectedChildStderr(holdLine('run-1') + holdLine('run-2'))).toBe('');
    expect(unexpectedChildStderr(`${holdLine('run-1')}boom\n`)).toBe('boom\n');
    expect(unexpectedChildStderr('[bureau] Run "run-1" failed\n')).toBe(
      '[bureau] Run "run-1" failed\n',
    );
  });

  it('drops every exact resolver-hold line and preserves near matches', () => {
    expect(unexpectedChildStderr(resolverHoldLine('run-1') + resolverHoldLine('run-2'))).toBe('');
    expect(unexpectedChildStderr(resolverHoldLine())).toBe('');
    expect(unexpectedChildStderr(`${resolverHoldLine('run-1')}boom\n`)).toBe('boom\n');
    expect(
      unexpectedChildStderr(
        '[bureau] Run "run-1" needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog\n',
      ),
    ).toBe(
      '[bureau] Run "run-1" needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog\n',
    );
    expect(
      unexpectedChildStderr(
        '[bureau] Run "run-1" needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog.\ntrailing\n',
      ),
    ).toBe('trailing\n');
    expect(
      unexpectedChildStderr(
        '[bureau] A runner needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog.\n',
      ),
    ).toBe(
      '[bureau] A runner needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog.\n',
    );
    expect(
      unexpectedChildStderr(
        '[bureau] Run "" needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog.\n',
      ),
    ).toBe(
      '[bureau] Run "" needs the agent run options resolver before the bureau has wired it; holding it until the bureau finishes building its agent catalog.\n',
    );
  });

  it('is what every clean-child assertion in this package compares', () => {
    // A test that compares a child's raw stderr against '' fails at random on a loaded host,
    // whenever the engine reclaims a run before Bureau finishes composing.
    const source = join(import.meta.dir, '..');
    const rawEmptyStderr = /stderr\)\.toBe\(''\)|\bstderr: ''/;
    const offenders: string[] = [];
    const visit = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (
          entry.name.endsWith('.test.ts') &&
          rawEmptyStderr.test(readFileSync(path, 'utf8'))
        ) {
          offenders.push(relative(source, path));
        }
      }
    };
    visit(source);
    expect(offenders).toEqual([]);
  });
});

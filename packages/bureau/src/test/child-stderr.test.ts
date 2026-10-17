import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'bun:test';

import { unexpectedChildStderr } from './child-stderr';

const holdLine = (runId: string) =>
  `[bureau] Run "${runId}" reached recovery before the bureau finished composing; holding it until composition completes.\n`;

describe('unexpectedChildStderr', () => {
  it('drops every composition-hold line and nothing else', () => {
    expect(unexpectedChildStderr(holdLine('run-1') + holdLine('run-2'))).toBe('');
    expect(unexpectedChildStderr(`${holdLine('run-1')}boom\n`)).toBe('boom\n');
    expect(unexpectedChildStderr('[bureau] Run "run-1" failed\n')).toBe(
      '[bureau] Run "run-1" failed\n',
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

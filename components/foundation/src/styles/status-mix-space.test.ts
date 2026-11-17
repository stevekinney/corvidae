/**
 * Component CSS that blends a status tone with a surface or text token mixes
 * in `oklab`, as the corpus's own status tiers do (`hue-travel.test.ts`).
 * `in oklch` interpolates hue around the wheel from the tone toward the cool
 * h245 neutrals, so a green or amber tone lands on cyan or olive on the way.
 */

import { Glob } from 'bun';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
const SOURCES = new Glob('{components,packages,applications}/*/src/**/*.{css,svelte}');

/** Every balanced `color-mix(...)` call in a source, whitespace-collapsed, with its line. */
function colorMixCalls(source: string): Array<{ call: string; line: number }> {
  const calls: Array<{ call: string; line: number }> = [];
  for (let start = source.indexOf('color-mix('); start !== -1;) {
    let depth = 0;
    let end = start + 'color-mix'.length;
    for (; end < source.length; end += 1) {
      if (source[end] === '(') depth += 1;
      else if (source[end] === ')' && --depth === 0) break;
    }
    calls.push({
      call: source.slice(start, end + 1).replace(/\s+/g, ' '),
      line: source.slice(0, start).split('\n').length,
    });
    start = source.indexOf('color-mix(', end);
  }
  return calls;
}

test('status tones mix with neutrals in oklab', async () => {
  const offenders: string[] = [];
  for await (const path of SOURCES.scan({ cwd: repositoryRoot })) {
    if (/[\\/](?:build|node_modules|\.svelte-kit)[\\/]/.test(path)) continue;
    const source = await Bun.file(join(repositoryRoot, path)).text();
    for (const { call, line } of colorMixCalls(source)) {
      if (
        /in oklch/.test(call) &&
        /--cinder-status-/.test(call) &&
        /--cinder-(?:surface|text)/.test(call)
      ) {
        offenders.push(`${path}:${line}  ${call}`);
      }
    }
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});

test('the scan recognizes a multi-line oklch status mix', () => {
  const [mix] = colorMixCalls(
    'a { background: color-mix(\n  in oklch,\n  var(--cinder-status-success-solid),\n  var(--cinder-surface) 36%\n); }',
  );
  expect(mix?.call).toBe(
    'color-mix( in oklch, var(--cinder-status-success-solid), var(--cinder-surface) 36% )',
  );
});

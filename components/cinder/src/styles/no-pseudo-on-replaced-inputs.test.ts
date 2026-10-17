/**
 * `::before` and `::after` on an `<input>`, `<select>`, or `<textarea>` are not
 * reliably rendered: they are replaced elements, Firefox drops the pseudo
 * element, and DOM-to-image capture loses it. A checkmark or dash drawn that
 * way disappears. Glyphs belong on a sibling indicator element (Checkbox's
 * `.cinder-checkbox-field__indicator`) or in a `background-image`.
 */

import { Glob } from 'bun';
import { join } from 'node:path';

import { expect, test } from 'bun:test';

const repositoryRoot = join(import.meta.dir, '..', '..', '..', '..');
const SOURCES = new Glob('{components,packages,applications}/*/src/**/*.{css,svelte}');
/** A compound selector on a replaced control (by element or by its Cinder class) with a pseudo-element. */
const PSEUDO_ON_REPLACED =
  /(?:^|[\s>+~,(])(?:input|select|textarea|\.cinder-(?:checkbox|radio|input|select|textarea))(?![\w-])[^\s>+~,{]*::?(?:before|after)\b/gm;

test('no pseudo-element is drawn on a replaced form control', async () => {
  const offenders: string[] = [];
  for await (const path of SOURCES.scan({ cwd: repositoryRoot })) {
    if (/[\\/](?:build|node_modules|\.svelte-kit)[\\/]/.test(path)) continue;
    const source = await Bun.file(join(repositoryRoot, path)).text();
    for (const match of source.matchAll(PSEUDO_ON_REPLACED)) {
      offenders.push(
        `${path}:${source.slice(0, match.index).split('\n').length}  ${match[0].trim()}`,
      );
    }
  }
  expect(offenders, offenders.join('\n')).toEqual([]);
});

test('the pattern catches the shapes it exists for', () => {
  for (const selector of [
    "input[type='checkbox']:checked::after",
    '.cinder-checkbox:indeterminate::before',
    'label > input::after',
  ]) {
    expect(selector.match(PSEUDO_ON_REPLACED), selector).not.toBeNull();
  }
  for (const selector of [
    '.cinder-checkbox:checked + .cinder-checkbox-field__indicator',
    '.cinder-checkbox-field::after',
    '.cinder-input-group::before',
  ]) {
    expect(selector.match(PSEUDO_ON_REPLACED), selector).toBeNull();
  }
});

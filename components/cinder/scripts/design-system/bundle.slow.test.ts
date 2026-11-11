/**
 * Builds the real `components/bundle.js`, Cinder's components and the editor's, and runs it in the
 * test's DOM, in the slow lane: bundling every component takes longer than the fast lane's
 * budget. The entry, header and runtime are covered quickly in `bundle.test.ts` and
 * `bundle-runtime.test.ts`.
 */
import {
  createTemporaryDirectory,
  removeTemporaryPath,
} from '@lostgradient/testing/temporary-path';
import { waitUntil } from '@lostgradient/testing/wait-until';
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { installModalDialogStubs } from '../../src/components/modal/modal-test-helpers.ts';
import { buildComponentBundle } from './bundle-build.ts';
import type { CinderGlobal, MountedCinder } from './bundle-runtime.svelte.ts';
import { bundleHeader } from './bundle.ts';
import { bundleSources, readManifestSources } from './sources.ts';

installModalDialogStubs();

const sources = bundleSources(readManifestSources());
const names = sources.flatMap((source) => source.names);

let directory: string | undefined;
let bundlePath = '';
let script = '';
let cinder: CinderGlobal | undefined;
const mounted: MountedCinder[] = [];

beforeAll(async () => {
  directory = createTemporaryDirectory('cinder-design-system-bundle');
  script = await buildComponentBundle(sources, join(directory, 'entry'));
  bundlePath = join(directory, 'bundle.js');
  writeFileSync(bundlePath, script);
  await import(bundlePath);
  cinder = (window as unknown as { Cinder?: CinderGlobal }).Cinder;
});

afterEach(() => {
  for (const instance of mounted.splice(0)) instance.destroy();
  document.body.replaceChildren();
});

afterAll(() => {
  if (directory) removeTemporaryPath(directory);
});

function exposedCinder(): CinderGlobal {
  if (cinder === undefined) throw new Error('bundle.js did not assign window.Cinder');
  return cinder;
}

function target(): HTMLDivElement {
  const element = document.createElement('div');
  document.body.append(element);
  return element;
}

describe('components/bundle.js', () => {
  test('exists as one classic script with its header and no import or markup terminator', () => {
    expect(existsSync(bundlePath)).toBe(true);
    expect(script.startsWith(bundleHeader(names))).toBe(true);
    expect(script).not.toMatch(/<\/script/i);
    expect(script).not.toContain('<!--');
    expect(script).not.toMatch(/^\s*import\s/m);
  });

  test('exposes every manifest component on window.Cinder', () => {
    const exposed = exposedCinder();
    expect(exposed.componentNames).toEqual(names);
    for (const name of names) expect(typeof exposed[name]).toBe('function');
  });

  test('mounts Button, Card and Modal by name with props and children', () => {
    const exposed = exposedCinder();

    const button = target();
    mounted.push(exposed.mount('Button', button, { variant: 'primary' }, 'Process inbox'));
    expect(button.querySelector('button')?.textContent).toContain('Process inbox');

    const card = target();
    mounted.push(exposed.mount('Card', card, { title: 'Inbox' }, 'Three items to process'));
    expect(card.textContent).toContain('Inbox');
    expect(card.textContent).toContain('Three items to process');

    mounted.push(exposed.mount('Modal', target(), { open: true, title: 'Rename list' }, 'Body'));
    const dialog = document.body.querySelector('dialog');
    expect(dialog?.textContent).toContain('Rename list');
    expect(dialog?.textContent).toContain('Body');
  });

  test('inlines the editor package and mounts MarkdownEditor once it loads', async () => {
    // A dynamic import left in the script would fetch a chunk the design system does not have.
    expect(script).not.toMatch(/\bimport\(/);
    for (const name of ['MarkdownEditor', 'ReviewEditor', 'DiffViewer']) {
      expect(names).toContain(name);
    }
    const editor = target();
    mounted.push(
      exposedCinder().mount('MarkdownEditor', editor, { id: 'notes', value: '# Notes' }),
    );
    await waitUntil(() => editor.querySelector('.markdown-editor') !== null, {
      message: 'MarkdownEditor to mount from the lazily loaded editor package',
    });
  });
});

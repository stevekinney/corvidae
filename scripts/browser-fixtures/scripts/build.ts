import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  buildFixtures as buildSuiteFixtures,
  type FixtureBuild,
} from '@lostgradient/testing/browser/build';
import {
  buildWebComponents,
  type ElementOptions,
} from '../../../components/cinder/scripts/build-web-components.ts';
import { ensureCinderGenerated } from '../../../components/cinder/scripts/ensure-cinder-generated.ts';
import { defaultManifestLayout } from './prepare-manifest.ts';

const root = resolve(import.meta.dirname, '..');
const outputDirectory = resolve(root, 'build');

/** The root suite's build: its page, its manifest layout, and `build/`. */
const rootFixtureBuild: FixtureBuild = {
  layout: defaultManifestLayout,
  indexHtml: resolve(root, 'index.html'),
  outputDirectory,
};

/** Standalone browser proof for the sibling workspaces. */
async function buildWorkspaceWebComponents(outdir: string): Promise<void> {
  const components = resolve(root, '../../components');
  const chat = resolve(components, 'chat/src/lib/components/chat');
  const editor = resolve(components, 'editor/src/lib/components/markdown-editor');
  const terminal = resolve(components, 'terminal/src/lib/components/terminal');
  const definitions = {
    chat: {
      directory: chat,
      stylesheets: [resolve(chat, 'chat.css')],
      propsType: 'ChatProps',
      hostDisplay: 'block',
      properties: {
        id: { attribute: 'chat-id' },
        conversation: {},
        onSubmit: {},
        composerPlaceholder: { attribute: 'composer-placeholder' },
      },
    },
    'markdown-editor': {
      directory: editor,
      stylesheets: [resolve(editor, 'prosemirror.css')],
      propsType: 'MarkdownEditorProps',
      hostDisplay: 'block',
      properties: { id: { attribute: 'editor-id' }, label: {}, value: {}, onValueChange: {} },
    },
    terminal: {
      directory: terminal,
      stylesheets: [
        fileURLToPath(import.meta.resolve('@xterm/xterm/css/xterm.css')),
        resolve(terminal, 'terminal.css'),
      ],
      propsType: 'TerminalProps',
      hostDisplay: 'block',
      properties: { title: {}, state: {}, controller: {}, ownerGeometry: {} },
    },
  } satisfies Record<string, ElementOptions>;
  await buildWebComponents(outdir, {
    definitions,
    example: resolve(root, 'fixtures/workspace-web-components.html'),
    exampleEntry: resolve(root, 'fixtures/workspace-web-components.ts'),
  });
}

export async function buildFixtures(development = false): Promise<void> {
  await ensureCinderGenerated();
  await buildSuiteFixtures(rootFixtureBuild, development);
  await buildWebComponents(resolve(outputDirectory, 'web-components'));
  await buildWorkspaceWebComponents(resolve(outputDirectory, 'workspace-web-components'));
}

if (import.meta.main) {
  await buildFixtures(false);
  console.log(`built browser fixtures at ${outputDirectory}`);
}

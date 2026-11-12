import { describe, expect, test } from 'bun:test';

const chatInputPath = new URL('./chat-input.svelte', import.meta.url);

function stripCssComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '');
}

function cssBlocks(source: string, selector: string): string[] {
  const blocks: string[] = [];
  let searchStart = 0;

  while (searchStart < source.length) {
    const selectorIndex = source.indexOf(selector, searchStart);
    if (selectorIndex === -1) break;

    const openingBraceIndex = source.indexOf('{', selectorIndex);
    expect(openingBraceIndex, `Missing CSS block for selector: ${selector}`).toBeGreaterThanOrEqual(
      0,
    );

    let closed = false;
    let depth = 0;
    for (let index = openingBraceIndex; index < source.length; index++) {
      const character = source[index];
      if (character === '{') depth++;
      if (character === '}') depth--;
      if (depth === 0) {
        blocks.push(source.slice(openingBraceIndex + 1, index));
        searchStart = index + 1;
        closed = true;
        break;
      }
    }

    if (!closed) {
      throw new Error(`Unclosed CSS block for selector: ${selector}`);
    }
  }

  expect(blocks.length, `Missing CSS selector: ${selector}`).toBeGreaterThan(0);
  return blocks;
}

function expectDeclaration(block: string, property: string, value: string): void {
  const escapedValue = value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const declaration = new RegExp(`${property}\\s*:\\s*${escapedValue}\\s*;`);
  expect(block).toMatch(declaration);
}

describe('ChatInput layout CSS', () => {
  test('gives the native textarea composer non-zero tokenized horizontal padding', async () => {
    const chatInputSource = stripCssComments(await Bun.file(chatInputPath).text());
    const editorBlocks = cssBlocks(chatInputSource, '.chat-input-editor {');

    expectDeclaration(
      editorBlocks.find((block) => block.includes('padding:')) ?? '',
      'padding',
      'var(--cinder-space-1) var(--cinder-space-3)',
    );
  });

  test('keeps the composer height compact without editor wrapper variables', async () => {
    const chatInputSource = stripCssComments(await Bun.file(chatInputPath).text());

    const chatContainerBlock =
      cssBlocks(chatInputSource, '.chat-input-editor-container').find((block) =>
        block.includes('min-height'),
      ) ?? '';
    expectDeclaration(chatContainerBlock, 'min-height', 'var(--cinder-touch-target-min)');
    expect(chatInputSource).not.toContain('--editor-min-height');
    expect(chatInputSource).not.toContain('markdown-editor');
    expect(chatInputSource).not.toContain('ProseMirror');
  });

  test('keeps the collapsed attachment rows content-sized and reserves overflow only after reveal', async () => {
    const chatInputSource = stripCssComments(await Bun.file(chatInputPath).text());
    expect(chatInputSource).toMatch(/data-expanded=\{attachmentsExpanded \|\| undefined\}/);
    expect(chatInputSource).toMatch(
      /\.chat-input-attachments\[data-expanded\]\s*\{[^}]*max-block-size:\s*12rem;[^}]*overflow-y:\s*auto;/,
    );
    const base = cssBlocks(chatInputSource, '.chat-input-attachments {')[0] ?? '';
    expect(base).not.toContain('max-block-size');
    expect(base).not.toContain('overflow-y');
  });

  test('keeps the editor and toolbar at 44px while trimming only surrounding inset', async () => {
    const chatInputSource = stripCssComments(await Bun.file(chatInputPath).text());
    const editor = cssBlocks(chatInputSource, '.chat-input-editor {')[0] ?? '';
    expectDeclaration(editor, 'min-height', 'var(--cinder-touch-target-min)');
    expect(chatInputSource).toMatch(
      /\.chat-input \{[^}]*padding:\s*var\(--cinder-space-0-5, 0\.125rem\) var\(--cinder-space-2\);/,
    );
    expect(chatInputSource).toMatch(
      /\.chat-input \{[^}]*gap:\s*var\(--cinder-space-0-5, 0\.125rem\);/,
    );
    expect(chatInputSource).toContain('padding-block-end: var(--cinder-space-0-5, 0.125rem);');
  });
});

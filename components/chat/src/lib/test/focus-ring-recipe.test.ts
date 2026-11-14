import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, test } from 'bun:test';
import { parse, type AtRule, type Node, type Rule } from 'postcss';

function load(relativePath: string): string {
  return readFileSync(fileURLToPath(new URL(relativePath, import.meta.url)), 'utf8');
}

function loadSvelteStyle(relativePath: string): string {
  const source = load(relativePath);
  const match = source.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
  if (!match) throw new Error(`No <style> block found in ${relativePath}`);
  return match[1]!;
}

function findRules(css: string, selector: string): Rule[] {
  const matches: Rule[] = [];
  parse(css).walkRules((rule) => {
    if (rule.selectors.includes(selector)) matches.push(rule);
  });
  return matches;
}

function declarationValue(rule: Rule, property: string): string | undefined {
  let value: string | undefined;
  rule.walkDecls(property, (declaration) => {
    value = declaration.value;
  });
  return value;
}

function isUnderForcedColors(node: Node): boolean {
  let current = node.parent;
  while (current) {
    const atRule = current.type === 'atrule' ? (current as AtRule) : undefined;
    if (
      atRule !== undefined &&
      atRule.name.toLowerCase() === 'media' &&
      atRule.params
        .split(',')
        .every((branch) => /\(\s*forced-colors\s*:\s*active\s*\)/i.test(branch))
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

const TRANSPARENT_OUTLINE = 'var(--cinder-ring-width) solid transparent';
const SHARED_BOX_SHADOW = 'var(--_cinder-focus-ring-shadow)';

function assertInsetRecipe(css: string, selector: string): void {
  const base = findRules(css, selector).find((rule) => !isUnderForcedColors(rule));
  expect(base).toBeDefined();
  expect(declarationValue(base!, 'outline')).toBe(TRANSPARENT_OUTLINE);
  expect(declarationValue(base!, 'box-shadow')).toContain('inset');
  expect(declarationValue(base!, 'box-shadow')).toContain('var(--cinder-ring-color)');
  expect(declarationValue(base!, 'box-shadow')).not.toContain(SHARED_BOX_SHADOW);

  const fallback = findRules(css, selector).find((rule) => isUnderForcedColors(rule));
  expect(fallback).toBeDefined();
  expect(declarationValue(fallback!, 'outline')).toBe('var(--cinder-ring-width) solid ButtonText');
  expect(declarationValue(fallback!, 'outline-offset')).toBe('calc(var(--cinder-ring-width) * -1)');
}

function assertOuterRecipe(css: string, selector: string): void {
  const base = findRules(css, selector).find((rule) => !isUnderForcedColors(rule));
  expect(base).toBeDefined();
  expect(declarationValue(base!, 'outline')).toBe(TRANSPARENT_OUTLINE);
  expect(declarationValue(base!, 'box-shadow')).toContain(SHARED_BOX_SHADOW);

  const fallback = findRules(css, selector).find((rule) => isUnderForcedColors(rule));
  expect(fallback).toBeDefined();
  expect(declarationValue(fallback!, 'outline')).not.toContain('transparent');
}

const styles = {
  artifactPanel: loadSvelteStyle('../components/chat/artifact/artifact-panel.svelte'),
  chat: load('../components/chat/chat.css'),
  exportActions: loadSvelteStyle('../components/chat/export/conversation-export-actions.svelte'),
  input: loadSvelteStyle('../components/chat/input/chat-input.svelte'),
  jumpControls: loadSvelteStyle('../components/chat/container/chat-jump-controls.svelte'),
  lightbox: loadSvelteStyle('../components/chat/message/image-lightbox.svelte'),
  message: loadSvelteStyle('../components/chat/message/chat-message.svelte'),
  messageAttachments: loadSvelteStyle('../components/chat/message/message-attachments.svelte'),
  markdownTable: loadSvelteStyle('../components/chat/message/markdown-table-scroller.svelte'),
  searchBar: loadSvelteStyle('../components/chat/container/chat-search-bar.svelte'),
  toolCallTimeline: loadSvelteStyle('../components/chat/message/tool-call-timeline.svelte'),
  chatImplementation: loadSvelteStyle('../components/chat/container/chat.svelte'),
};

describe('Chat focus-ring recipes', () => {
  const insetCases = [
    ['artifact-panel close', styles.artifactPanel, '.artifact-panel-close:focus-visible'],
    [
      'message attachment button',
      styles.messageAttachments,
      '.message-attachment-button:focus-visible',
    ],
    [
      'markdown table scroller',
      styles.markdownTable,
      '.message-markdown-table-scroller:focus-visible',
    ],
  ] as const;

  for (const [name, style, selector] of insetCases) {
    test(`${name} uses the inset recipe`, () => assertInsetRecipe(style, selector));
  }

  test('the scrollable timeline uses a bounded inline focus rail', () => {
    for (const [style, selector] of [
      [styles.chat, '.cinder-chat .chat-timeline:focus-visible'],
      [styles.chatImplementation, '.chat-timeline:focus-visible'],
    ] as const) {
      const labelSelector =
        selector === '.cinder-chat .chat-timeline:focus-visible'
          ? '.cinder-chat .chat-timeline-focus-label'
          : '.chat-timeline-focus-label';
      const rule = findRules(style, labelSelector).find(
        (candidate) => !isUnderForcedColors(candidate),
      );
      expect(declarationValue(rule!, 'position')).toBe('sticky');
      expect(declarationValue(rule!, 'block-size')).toBe('0');
      expect(declarationValue(rule!, 'min-block-size')).toBe('0');
      expect(declarationValue(rule!, 'inset-block-start')).toBe('var(--cinder-space-2)');
      expect(findRules(style, `${labelSelector}::after`)).not.toEqual([]);
      expect(findRules(style, `${selector} .chat-timeline-focus-label`)).not.toEqual([]);
    }
  });
  const outerCases = [
    ['tool-call timeline', styles.toolCallTimeline, '.chat-tool-call-timeline:focus-visible'],
    [
      'chat export trigger',
      styles.exportActions,
      '.conversation-export-actions :global(.export-trigger:focus-visible)',
    ],
    ['chat search navigation', styles.searchBar, '.chat-search-nav-button:focus-visible'],
    ['chat jump button', styles.jumpControls, '.chat-jump-button:focus-visible'],
    ['chat message row', styles.message, '.chat-message:focus-visible'],
    ['chat message expand', styles.message, '.chat-message-expand:focus-visible'],
    ['chat message retry', styles.message, '.chat-message-retry:focus-visible'],
    ['chat message action', styles.message, ':global(.chat-message-action-button:focus-visible)'],
    ['chat message edit save', styles.message, '.chat-message-edit-save:focus-visible'],
    ['chat message edit cancel', styles.message, '.chat-message-edit-cancel:focus-visible'],
  ] as const;

  for (const [name, style, selector] of outerCases) {
    test(`${name} uses the outer recipe`, () => assertOuterRecipe(style, selector));
  }

  test('chat empty prompts delegate their focus ring to Cinder Button', () => {
    const source = load('../components/chat/container/chat.svelte');
    expect(source).toMatch(/<Button[\s\S]*class="chat-empty-prompt"/u);
    expect(source).not.toContain('.chat-empty-prompt:focus-visible');
  });

  test('message edit textarea uses the outer recipe and Highlight fallback', () => {
    const selector = '.chat-message-edit-textarea:focus';
    assertOuterRecipe(styles.message, selector);
    const fallback = findRules(styles.message, selector).find((rule) => isUnderForcedColors(rule));
    expect(declarationValue(fallback!, 'outline')).toBe('var(--cinder-ring-width) solid Highlight');
    expect(declarationValue(fallback!, 'outline-offset')).toBe('1px');
  });

  // Updated for COR-1498: the new-message indicator and the send button are solid
  // accent fills, so their focus ring is the filled formula: a page-coloured gap,
  // then the standard ring. The indicator moved out of the outer-recipe list above.
  const FILLED_BOX_SHADOW = 'var(--_cinder-focus-ring-filled-shadow)';

  test('chat new indicator paints the filled ring (gap, then ring) with its elevation', () => {
    const base = findRules(styles.jumpControls, '.chat-new-indicator:focus-visible').find(
      (rule) => !isUnderForcedColors(rule),
    );
    expect(declarationValue(base!, 'outline')).toBe(TRANSPARENT_OUTLINE);
    expect(declarationValue(base!, 'box-shadow')).toContain(FILLED_BOX_SHADOW);
    expect(declarationValue(base!, 'box-shadow')).toContain('var(--cinder-shadow-lg)');
    const fallback = findRules(styles.jumpControls, '.chat-new-indicator:focus-visible').find(
      (rule) => isUnderForcedColors(rule),
    );
    expect(declarationValue(fallback!, 'outline')).not.toContain('transparent');
  });

  test('Send, Answer and Stop are Cinder secondary buttons, so the ring is Cinder own', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../components/chat/input/chat-input.svelte', import.meta.url)),
      'utf8',
    );
    expect(source).toMatch(
      /data-chat-send=""[\s\S]*?variant="secondary"|variant="secondary"[\s\S]*?data-chat-send=""/,
    );
    expect(findRules(styles.input, '.chat-input-send:focus-visible')).toEqual([]);
    expect(findRules(styles.input, '.chat-input-send[data-stop]:focus-visible')).toEqual([]);
  });

  test('the elevated composer draws the focus ring around itself, over its shadow, and an outline under forced colours', () => {
    const focusRules = findRules(styles.input, '.chat-input:has(.chat-input-editor:focus)');
    const base = focusRules.find((rule) => !isUnderForcedColors(rule));
    const shadow = declarationValue(base!, 'box-shadow');
    expect(shadow).toContain('var(--cinder-shadow-md)');
    expect(shadow).toContain('var(--cinder-ring-color)');
    const fallback = focusRules.find((rule) => isUnderForcedColors(rule));
    expect(declarationValue(fallback!, 'outline')).toContain('Highlight');
    // No accent edge or glow says a draft is ready: Send filled with the accent does.
    expect(styles.input).not.toContain('.chat-input[data-ready]');
  });

  test('attachment Remove, Retry and "more" are Cinder Buttons whose ring wraps the painted face', () => {
    const source = load('../components/chat/input/chat-input.svelte');
    for (const name of [
      'chat-input-attachment-remove',
      'chat-input-attachment-retry',
      'chat-input-attachment-more',
    ]) {
      expect(source).toMatch(new RegExp(`<Button[^>]*?class="${name}"`, 'u'));
      // No Chat rule repaints or suppresses the ring: Cinder's own recipe is the only one.
      expect(styles.input).not.toMatch(new RegExp(`\\.${name}[^{]*:focus`, 'u'));
      expect(findRules(styles.input, `.${name}::before`)).toEqual([]);
    }

    // Cinder paints that ring as a box-shadow on the button itself, which is the painted face;
    // the 44px hit extension is the separate ::before pseudo-element and carries no ring.
    const buttonCss = readFileSync(
      fileURLToPath(
        new URL('../../../../cinder/src/components/button/button.css', import.meta.url),
      ),
      'utf8',
    );
    const ring = findRules(buttonCss, '.cinder-button:focus-visible').find(
      (rule) => !isUnderForcedColors(rule),
    );
    expect(declarationValue(ring!, 'outline')).toBe(TRANSPARENT_OUTLINE);
    expect(declarationValue(ring!, 'box-shadow')).toContain('var(--cinder-ring-color)');
    const forced = findRules(buttonCss, '.cinder-button:focus-visible').find((rule) =>
      isUnderForcedColors(rule),
    );
    expect(declarationValue(forced!, 'outline')).toBe('var(--cinder-ring-width) solid ButtonText');
    for (const rule of findRules(
      buttonCss,
      ".cinder-button[data-cinder-hit-target='44']::before",
    )) {
      expect(declarationValue(rule, 'box-shadow')).toBeUndefined();
      expect(declarationValue(rule, 'outline')).toBeUndefined();
    }
  });

  for (const selector of ['.lightbox-close:focus-visible', '.lightbox-nav:focus-visible']) {
    test(`${selector} preserves the white-over-photo exception`, () => {
      const rule = findRules(styles.lightbox, selector).find(
        (entry) => !isUnderForcedColors(entry),
      );
      expect(declarationValue(rule!, 'outline')).toBe('2px solid white');
    });
  }

  test('conversation-list button repaints its forced-colors outline', () => {
    const css = load('../components/chat-conversation-list/chat-conversation-list.css');
    const selector =
      '.cinder-chat-conversation-list__button[data-cinder-conversation-interactive]:focus-visible';
    const base = findRules(css, selector).find((rule) => !isUnderForcedColors(rule));
    expect(declarationValue(base!, 'outline')).toContain('transparent');
    expect(declarationValue(base!, 'box-shadow')).toBeDefined();

    const fallback = findRules(css, selector).find((rule) => isUnderForcedColors(rule));
    expect(declarationValue(fallback!, 'outline')).toBe(
      'var(--cinder-ring-width) solid ButtonText',
    );
    expect(declarationValue(fallback!, 'outline-offset')).toBe('3px');
    expect(declarationValue(fallback!, 'box-shadow')).toBe('none');
  });
});

describe('Chat composer controls (COR-1552)', () => {
  test('the input area has no top rule', () => {
    const rules = findRules(styles.chatImplementation, '.chat-input-area');
    expect(rules.length).toBeGreaterThan(0);
    for (const rule of rules) {
      expect(declarationValue(rule, 'border-top')).toBeUndefined();
      expect(declarationValue(rule, 'border')).toBeUndefined();
    }
  });

  test('the composer is elevated on the control background, with no outline at rest (COR-2327 AC2)', () => {
    const frame = findRules(styles.input, '.chat-input').find((rule) => !isUnderForcedColors(rule));
    expect(declarationValue(frame!, 'background')).toBe('var(--cinder-control-background)');
    expect(declarationValue(frame!, 'border')).toBe('1px solid transparent');
    expect(declarationValue(frame!, 'box-shadow')).toBe('var(--cinder-shadow-md)');
    // Forced colours drop the shadow, so the edge is drawn there instead.
    const forced = findRules(styles.input, '.chat-input').find((rule) => isUnderForcedColors(rule));
    expect(declarationValue(forced!, 'border-color')).toBe('CanvasText');
  });

  test('Stop keeps the neutral control border; Cinder draws the quiet disabled Send', () => {
    const stop = findRules(
      styles.input,
      '.chat-input-footer-right :global(.chat-input-send[data-stop])',
    );
    expect(stop.length).toBeGreaterThan(0);
    expect(declarationValue(stop[0]!, 'border-color')).toBe('var(--cinder-control-border)');
    // The shape, the disabled look and the touch target belong to Cinder's Button.
    expect(findRules(styles.input, '.chat-input-send:disabled')).toEqual([]);
    expect(findRules(styles.input, '.chat-input-send::after')).toEqual([]);
  });
});

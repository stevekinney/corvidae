import { describe, expect, test } from 'bun:test';

import {
  CONVERT_COMPONENT_METADATA_COMMAND,
  extractTaggedSource,
  metaFromTags,
  pendingReport,
} from './convert-component-metadata.ts';

const tagged = `<script lang="ts" module>
  /**
   * @cinder
   * @category action
   * @status beta
   * @purpose A purpose that wraps
   *   onto a second line.
   * @tag one
   * @tag two
   * @useWhen Pressing it.
   * @avoidWhen Toggling | toggle
   * @avoidWhen Reading.
   * @related button, copy-button
   * @rationale Nearest alternative: button.
   * @a11yPattern WAI-ARIA Button
   * @keyboardShortcut Enter / Space | Activates it
   * @a11yNote Announces its state.
   */

  export type { WidgetProps } from './widget.types.ts';
</script>

<script lang="ts">
  let { label } = $props();
</script>
`;

describe('extractTaggedSource', () => {
  test('reads the tags and removes the block with the blank line after it', () => {
    const result = extractTaggedSource(tagged);
    expect(result?.stripped).toBe(`<script lang="ts" module>
  export type { WidgetProps } from './widget.types.ts';
</script>

<script lang="ts">
  let { label } = $props();
</script>
`);
    expect(result?.tags.find((tag) => tag.name === 'purpose')?.value).toBe(
      'A purpose that wraps onto a second line.',
    );
  });

  test('removes a module script the block was all of', () => {
    const source = `<script lang="ts" module>
  /**
   * @cinder
   * @category action
   */
</script>

<div></div>
`;
    expect(extractTaggedSource(source)?.stripped).toBe('<div></div>\n');
  });

  test('leaves a file with no @cinder block alone', () => {
    expect(extractTaggedSource('<script lang="ts" module>\n  /** A note. */\n</script>\n')).toBe(
      undefined,
    );
  });
});

describe('metaFromTags', () => {
  test('maps every tag to its meta.json field', () => {
    const tags = extractTaggedSource(tagged)?.tags ?? [];
    expect(metaFromTags(tags)).toEqual({
      category: 'action',
      status: 'beta',
      purpose: 'A purpose that wraps onto a second line.',
      tags: ['one', 'two'],
      useWhen: ['Pressing it.'],
      avoidWhen: [{ reason: 'Toggling', alternative: 'toggle' }, { reason: 'Reading.' }],
      related: ['button', 'copy-button'],
      rationale: 'Nearest alternative: button.',
      a11y: {
        pattern: 'WAI-ARIA Button',
        keyboard: [{ keys: 'Enter / Space', action: 'Activates it' }],
        notes: ['Announces its state.'],
      },
    });
  });

  test('refuses a duplicated single-valued tag', () => {
    expect(() =>
      metaFromTags([
        { name: 'category', value: 'action' },
        { name: 'category', value: 'form' },
      ]),
    ).toThrow('duplicate @category tag');
  });
});

describe('the --check report', () => {
  // A component that still authors @cinder tags (a branch that merged main after this change) is
  // work `lint:checks` reports through `--check`, and the report names the command that converts
  // it. Whether the tree has work left is that lint step's job, not this test's: planning the
  // conversion formats every metadata file.
  test('names each file and the codemod that converts it', () => {
    const report = pendingReport([
      { file: '/x/widget.svelte', reason: 'module-script @cinder tags to move into JSON' },
    ]);
    expect(report).toContain(CONVERT_COMPONENT_METADATA_COMMAND);
    expect(report).toContain('widget.svelte: module-script @cinder tags to move into JSON');
  });
});

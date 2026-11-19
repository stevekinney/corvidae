/// <reference lib="dom" />
/**
 * A note's identifier part (`noteCode`), drawn in the mono family at the note's size, and a long
 * tag in a `tags` definition, which is shortened with an ellipsis and keeps its whole text as its
 * title so it never runs out of its row.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: DescriptionList } = await import('./description-list.svelte');

const stylesheet = readFileSync(new URL('./description-list.css', import.meta.url), 'utf8');

afterEach(() => cleanup());

describe('noteCode', () => {
  test('draws an identifier in code at the note’s start, a space before the note’s words', () => {
    const { container } = render(DescriptionList, {
      props: {
        items: [
          {
            term: 'Workflow',
            definition: 'Chat with an agent',
            noteCode: 'agentRun',
            note: '(built in)',
          },
        ],
      },
    });
    const note = container.querySelector('.cinder-description-list__note');
    expect(note?.querySelector('code.cinder-description-list__note-code')?.textContent).toBe(
      'agentRun',
    );
    expect(note?.textContent).toBe('agentRun (built in)');
    expect(stylesheet).toMatch(
      /\.cinder-description-list__note-code \{[^}]*font-family: var\(--cinder-font-mono\);[^}]*font-size: inherit;/,
    );
  });

  test('is drawn without words, and nothing is drawn when both are empty', () => {
    const alone = render(DescriptionList, {
      props: { items: [{ term: 'Run ID', definition: 'Run 8f2c', noteCode: 'run-8f2c0d71' }] },
    });
    expect(alone.container.querySelector('.cinder-description-list__note')?.textContent).toBe(
      'run-8f2c0d71',
    );
    alone.unmount();
    const empty = render(DescriptionList, {
      props: { items: [{ term: 'Run ID', definition: 'x', noteCode: '', note: '' }] },
    });
    expect(empty.container.querySelector('.cinder-description-list__note')).toBeNull();
  });
});

describe('a long tag', () => {
  test('keeps its whole text as its title and is shortened with an ellipsis', () => {
    const long = `bureau-steering-run:${'a1b2c3d4e5'.repeat(4)}`;
    const { container } = render(DescriptionList, {
      props: { items: [{ term: 'Tags', definition: { type: 'tags', tags: [long] } }] },
    });
    const tag = container.querySelector('.cinder-description-list__tag');
    expect(tag?.getAttribute('title')).toBe(long);
    expect(stylesheet).toMatch(
      /\.cinder-description-list__tag \.cinder-chip__label \{[^}]*overflow: hidden;[^}]*text-overflow: ellipsis;[^}]*white-space: nowrap;/,
    );
    expect(stylesheet).toMatch(
      /\.cinder-description-list__tag \{[^}]*min-inline-size: 0;[^}]*max-inline-size: 100%;/,
    );
  });
});

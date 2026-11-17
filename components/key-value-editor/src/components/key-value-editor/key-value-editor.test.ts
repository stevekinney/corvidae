/// <reference lib="dom" />
import { requiredInstance, setupHappyDom } from '@lostgradient/testing';
import { afterEach, describe, expect, mock, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { tick } from 'svelte';
import type { KeyValueEntry } from './key-value-editor.types.ts';
setupHappyDom();
const buttonModule = await import('@lostgradient/button/components/button/index.ts');
const gridModule = await import('@lostgradient/grid/components/grid/index.ts');
const inputModule = await import('@lostgradient/input/components/input/index.ts');
mock.module('@lostgradient/cinder', () => buttonModule);
mock.module('@lostgradient/cinder', () => gridModule);
mock.module('@lostgradient/cinder', () => inputModule);
const { cleanup, fireEvent, render } = await import('@testing-library/svelte');
const { default: KeyValueEditor } = await import('./key-value-editor.svelte');
afterEach(cleanup);
describe('KeyValueEditor', () => {
  test('renders editable rows with unique per-instance input ids', () => {
    const first = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
    });
    const second = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
    });
    // One pair plus the empty row that adds the next one.
    expect(first.container.querySelectorAll('input')).toHaveLength(4);
    expect(second.container.querySelectorAll('input')).toHaveLength(4);
    expect(first.container.querySelector('input')?.id).not.toBe(
      second.container.querySelector('input')?.id,
    );
  });

  test('keeps secret values editable while masking their input', () => {
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'token', key: 'TOKEN', value: 'private' }],
      secret: (key: string) => key === 'TOKEN',
    });
    expect(container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe(
      'private',
    );
  });

  test('syncs externally replaced entries without emitting a feedback update', async () => {
    const updates: KeyValueEntry[][] = [];
    const { container, rerender } = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
      onValueChange: (next: KeyValueEntry[]) => updates.push(next),
    });
    await rerender({ entries: [{ id: 'port', key: 'Port', value: '443' }] });
    expect(container.querySelectorAll('input')[0]?.value).toBe('Port');
    expect(updates).toHaveLength(0);
  });

  test('renders editable rows', () => {
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
    });
    expect(container.querySelectorAll('.cinder-key-value-editor__row')).toHaveLength(2);
    expect(
      container.querySelectorAll('.cinder-key-value-editor__row[data-cinder-pending]'),
    ).toHaveLength(1);
  });

  test('typing into the empty last row adds a pair without moving focus, and a new empty row follows', async () => {
    const updates: KeyValueEntry[][] = [];
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
      onValueChange: (next: KeyValueEntry[]) => updates.push(next),
    });
    const pendingKey = requiredInstance(
      container.querySelector('.cinder-key-value-editor__row[data-cinder-pending] input'),
      HTMLInputElement,
    );
    pendingKey.focus();
    await fireEvent.input(pendingKey, { target: { value: 'P' } });
    await tick();

    expect(updates).toHaveLength(1);
    const [firstRow, secondRow] = updates[0]!;
    expect(firstRow).toEqual({ id: 'host', key: 'Host', value: 'localhost' });
    expect(secondRow).toMatchObject({ key: 'P', value: '' });
    expect(typeof secondRow?.id).toBe('string');
    expect(secondRow?.id.length).toBeGreaterThan(0);
    expect(secondRow?.id).not.toBe(firstRow?.id);

    // The input typed into is the same node, still focused, now in a real row with a Remove.
    expect(document.activeElement).toBe(pendingKey);
    expect(pendingKey.value).toBe('P');
    const promotedRow = requiredInstance(
      pendingKey.closest('.cinder-key-value-editor__row'),
      HTMLElement,
    );
    expect(promotedRow.hasAttribute('data-cinder-pending')).toBe(false);
    expect(promotedRow.querySelector('[aria-label="Remove P"]')).not.toBeNull();

    // A new empty row follows, and the next keystroke edits the added pair, not a third one.
    const rowsAfter = container.querySelectorAll('.cinder-key-value-editor__row');
    expect(rowsAfter).toHaveLength(3);
    expect(rowsAfter[2]?.hasAttribute('data-cinder-pending')).toBe(true);
    await fireEvent.input(pendingKey, { target: { value: 'PORT' } });
    expect(updates.at(-1)).toEqual([
      { id: 'host', key: 'Host', value: 'localhost' },
      { id: secondRow!.id, key: 'PORT', value: '' },
    ]);
  });

  test('typing a value first into the empty row adds a pair with an empty key', async () => {
    const updates: KeyValueEntry[][] = [];
    const { container } = render(KeyValueEditor, {
      onValueChange: (next: KeyValueEntry[]) => updates.push(next),
    });
    const inputs = container.querySelectorAll<HTMLInputElement>('input');
    expect(inputs).toHaveLength(2);
    await fireEvent.input(inputs[1]!, { target: { value: 'eu' } });
    expect(updates.at(-1)).toMatchObject([{ key: '', value: 'eu' }]);
  });

  test('the empty row is not in entries and has no Remove control', () => {
    const updates: KeyValueEntry[][] = [];
    const { container } = render(KeyValueEditor, {
      entries: [],
      onValueChange: (next: KeyValueEntry[]) => updates.push(next),
    });
    const pending = requiredInstance(
      container.querySelector('.cinder-key-value-editor__row[data-cinder-pending]'),
      HTMLElement,
    );
    expect(pending.querySelector('button')).toBeNull();
    expect(updates).toHaveLength(0);
  });

  test('the empty row keeps the key and value names and is described by the add label', () => {
    const { container, getAllByRole } = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
      addLabel: 'Add header',
    });
    expect(getAllByRole('textbox', { name: 'Key' })).toHaveLength(2);
    expect(getAllByRole('textbox', { name: 'Value' })).toHaveLength(2);
    const pendingInputs = container.querySelectorAll<HTMLInputElement>(
      '.cinder-key-value-editor__row[data-cinder-pending] input',
    );
    for (const input of pendingInputs) {
      const description = input
        .getAttribute('aria-describedby')
        ?.split(' ')
        .map((id) => document.getElementById(id)?.textContent?.trim())
        .join(' ');
      expect(description).toBe('Add header');
    }
    const realKey = requiredInstance(container.querySelector('input'), HTMLInputElement);
    expect(realKey.hasAttribute('aria-describedby')).toBe(false);
  });

  test('draws Key and Value once as headings hidden from assistive technology', () => {
    const { container } = render(KeyValueEditor, {
      entries: [
        { id: 'host', key: 'Host', value: 'localhost' },
        { id: 'port', key: 'Port', value: '443' },
      ],
      keyLabel: 'Name',
    });
    const headings = container.querySelectorAll('.cinder-key-value-editor__headings');
    expect(headings).toHaveLength(1);
    expect(headings[0]?.getAttribute('aria-hidden')).toBe('true');
    expect(headings[0]?.textContent?.replace(/\s+/g, ' ').trim()).toBe('Name Value');
    expect(container.querySelectorAll('label:not(.cinder-sr-only)')).toHaveLength(0);
  });
  test('marks secret cells as password inputs', () => {
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'token', key: 'TOKEN', value: 'private' }],
      secret: (key: string) => key === 'TOKEN',
    });
    expect(container.querySelector('input[type="password"]')).not.toBeNull();
  });

  test('composes an icon-only Remove from Button at the end of each row', () => {
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
    });
    expect(container.querySelectorAll('.cinder-button')).toHaveLength(1);
    const remove = requiredInstance(
      container.querySelector('[aria-label="Remove Host"]'),
      HTMLButtonElement,
    );
    expect(remove.classList).toContain('cinder-button');
    expect(remove.hasAttribute('data-cinder-icon-only')).toBe(true);
    expect(remove.textContent?.trim()).toBe('');
    // Three grid cells, key field, value field, Remove: the narrow layout places them by position.
    expect(remove.parentElement?.children).toHaveLength(3);
    expect(remove.parentElement?.lastElementChild).toBe(remove);
  });

  test('restores focus to the empty row after removing the final row', async () => {
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'host', key: 'Host', value: 'localhost' }],
    });
    const removeButton = container.querySelector<HTMLButtonElement>('[aria-label="Remove Host"]');

    expect(removeButton).not.toBeNull();
    await fireEvent.click(removeButton!);

    const pendingKey = container.querySelector(
      '.cinder-key-value-editor__row[data-cinder-pending] input',
    );
    expect(document.activeElement).toBe(requiredInstance(pendingKey, HTMLInputElement));
  });

  test('restores focus to the preceding row Remove button after removing a later row', async () => {
    const { container } = render(KeyValueEditor, {
      entries: [
        { id: 'host', key: 'Host', value: 'localhost' },
        { id: 'port', key: 'Port', value: '443' },
      ],
    });
    const removePort = container.querySelector<HTMLButtonElement>('[aria-label="Remove Port"]');
    const removeHost = container.querySelector<HTMLButtonElement>('[aria-label="Remove Host"]');

    await fireEvent.click(removePort!);

    expect(document.activeElement).toBe(removeHost);
  });

  test('entry point imports only styles used by the rendered composition', () => {
    const entry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8');
    expect(entry).toContain("import '@lostgradient/input/input.css';");
    expect(entry).toContain("import '@lostgradient/button/button.css';");
    expect(entry).not.toContain('secret-value-field.css');
    expect(entry).not.toContain('grid.css');
  });

  // happy-dom does not apply @container rules, so the layout is pinned on the stylesheet text;
  // the browser fixture shows the rendered rows at desktop and phone widths.
  test('keeps a row on one line and, when very narrow, stacks key over value with Remove beside the key', () => {
    const css = readFileSync(new URL('./key-value-editor.css', import.meta.url), 'utf8');
    expect(css).toContain(
      'grid-template-columns: minmax(0, 2fr) minmax(0, 3fr) var(--cinder-control-height-md);',
    );
    expect(css).toContain('@container cinder-key-value-editor (max-width: 20rem)');
    expect(css).toMatch(/__row > :nth-child\(3\) \{\s*grid-column: 2;\s*grid-row: 1;/);
    const source = readFileSync(new URL('./key-value-editor.svelte', import.meta.url), 'utf8');
    expect(source).not.toContain('narrowCollapseEnabled');
  });

  test('composes primitives through public component subpaths', async () => {
    const source = await Bun.file(new URL('./key-value-editor.svelte', import.meta.url)).text();
    expect(source).toContain("from '@lostgradient/input/components/input/index.ts';");
    expect(source).toContain("from '@lostgradient/button/components/button/index.ts';");
    expect(source).not.toContain("from '@lostgradient/input/components/input/input.svelte'");
    expect(source).not.toContain("from '@lostgradient/button/components/button/button.svelte'");
  });

  // COR-504: row identity (KeyValueEntry.id) is immutable and independent of
  // the editable key/value text, so parent-driven entry updates preserve a
  // focused row's DOM node and focus instead of remounting rows by position.
  describe('COR-504: row identity across parent entry updates', () => {
    test('preserves a focused row input and its DOM node when the parent reorders, inserts, and removes other rows', async () => {
      const { container, rerender } = render(KeyValueEditor, {
        entries: [
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'b', key: 'Bravo', value: '2' },
          { id: 'c', key: 'Charlie', value: '3' },
        ],
      });
      const valueInputs = () => Array.from(container.querySelectorAll<HTMLInputElement>('input'));
      const bValueInput = valueInputs()[3]!; // [a-key, a-value, b-key, b-value, ...]
      expect(bValueInput.value).toBe('2');
      bValueInput.focus();

      // Insert a brand-new row before "a" (shifting "b" from index 1 to
      // index 2) and pass a fresh clone of "b" (new object identity, same
      // id), so this actually stresses id- vs index-based identity.
      await rerender({
        entries: [
          { id: 'd', key: 'Delta', value: '4' },
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'b', key: 'Bravo', value: '2' },
          { id: 'c', key: 'Charlie', value: '3' },
        ],
      });
      await tick();

      const bValueInputAfter = Array.from(
        container.querySelectorAll<HTMLInputElement>('input'),
      ).find((input) => input.value === '2');
      expect(bValueInputAfter).toBe(bValueInput);
      expect(document.activeElement).toBe(bValueInput);

      // Typing now updates only "b", not whatever row now sits at its old index.
      await fireEvent.input(bValueInput, { target: { value: '2-updated' } });
      expect(bValueInput.value).toBe('2-updated');
    });

    test('allows two rows with equal key and value text distinguished only by id, and editing one does not remount or unfocus it', async () => {
      const updates: KeyValueEntry[][] = [];
      const { container } = render(KeyValueEditor, {
        entries: [
          { id: 'first', key: 'DUPLICATE', value: 'same' },
          { id: 'second', key: 'DUPLICATE', value: 'same' },
        ],
        onValueChange: (next: KeyValueEntry[]) => updates.push(next),
      });
      const keyInputs = container.querySelectorAll<HTMLInputElement>('input');
      const secondKeyInput = keyInputs[2]!;
      secondKeyInput.focus();

      await fireEvent.input(secondKeyInput, { target: { value: 'RENAMED' } });

      expect(document.activeElement).toBe(secondKeyInput);
      expect(updates.at(-1)).toEqual([
        { id: 'first', key: 'DUPLICATE', value: 'same' },
        { id: 'second', key: 'RENAMED', value: 'same' },
      ]);
    });

    test('when the parent removes the focused row, focus falls back to the previous row Remove control', async () => {
      const { container, rerender } = render(KeyValueEditor, {
        entries: [
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'b', key: 'Bravo', value: '2' },
          { id: 'c', key: 'Charlie', value: '3' },
        ],
      });
      const inputs = container.querySelectorAll<HTMLInputElement>('input');
      const bKeyInput = inputs[2]!;
      bKeyInput.focus();

      await rerender({
        entries: [
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'c', key: 'Charlie', value: '3' },
        ],
      });
      await tick();
      await tick();

      expect(document.activeElement).toBe(container.querySelector('[aria-label="Remove Alpha"]'));
    });

    test('when the parent removes the first (focused) row, focus falls to the next row Remove control', async () => {
      const { container, rerender } = render(KeyValueEditor, {
        entries: [
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'b', key: 'Bravo', value: '2' },
        ],
      });
      const inputs = container.querySelectorAll<HTMLInputElement>('input');
      const aKeyInput = inputs[0]!;
      aKeyInput.focus();

      await rerender({ entries: [{ id: 'b', key: 'Bravo', value: '2' }] });
      await tick();
      await tick();

      expect(document.activeElement).toBe(container.querySelector('[aria-label="Remove Bravo"]'));
    });

    test('when the parent removes the only (focused) row, focus falls back to the empty row', async () => {
      const { container, rerender } = render(KeyValueEditor, {
        entries: [{ id: 'a', key: 'Alpha', value: '1' }],
      });
      const removeButton = container.querySelector<HTMLButtonElement>(
        '[aria-label="Remove Alpha"]',
      );
      removeButton!.focus();

      await rerender({ entries: [] });
      await tick();
      await tick();

      const pendingKey = container.querySelector(
        '.cinder-key-value-editor__row[data-cinder-pending] input',
      );
      expect(document.activeElement).toBe(requiredInstance(pendingKey, HTMLInputElement));
    });

    test('a parent update that does not remove the focused row moves no focus', async () => {
      const { container, rerender } = render(KeyValueEditor, {
        entries: [
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'b', key: 'Bravo', value: '2' },
        ],
      });
      const removeAlpha = container.querySelector<HTMLButtonElement>('[aria-label="Remove Alpha"]');
      removeAlpha!.focus();

      await rerender({
        entries: [
          { id: 'a', key: 'Alpha', value: '1' },
          { id: 'b', key: 'Bravo', value: '2-changed' },
        ],
      });
      await tick();
      await tick();

      expect(document.activeElement).toBe(removeAlpha);
    });
  });
});

describe('KeyValueEditor as a labelled group (row 33q)', () => {
  test('a label makes the editor a named group and a description is linked to it', () => {
    const { container, getByRole } = render(KeyValueEditor, {
      entries: [{ id: 'token', key: 'GITHUB_TOKEN', value: 'private' }],
      label: 'Environment',
      description: 'Values are masked and stored on this machine like an API key.',
      secret: () => true,
    });
    const group = getByRole('group', { name: 'Environment' });
    const describedBy = group.getAttribute('aria-describedby');
    expect(document.getElementById(describedBy ?? '')?.textContent?.trim()).toBe(
      'Values are masked and stored on this machine like an API key.',
    );
    expect(container.querySelector('.cinder-key-value-editor__label')?.textContent).toBe(
      'Environment',
    );
  });

  test('without a label it stays a plain container', () => {
    const { container } = render(KeyValueEditor, { entries: [] });
    const root = requiredInstance(container.firstElementChild, HTMLElement);
    expect(root.hasAttribute('role')).toBe(false);
    expect(root.hasAttribute('aria-labelledby')).toBe(false);
    expect(root.hasAttribute('aria-describedby')).toBe(false);
  });

  test('key and value names, the add label and the remove label follow the vocabulary', () => {
    const { getByRole, getAllByLabelText, getByText } = render(KeyValueEditor, {
      entries: [{ id: 'token', key: 'GITHUB_TOKEN', value: 'private' }],
      keyLabel: 'Name',
      valueLabel: 'Value',
      addLabel: 'Add variable',
      removeLabel: (key: string) => `Remove ${key}`,
      secret: () => true,
    });
    expect((getAllByLabelText('Name')[0] as HTMLInputElement).value).toBe('GITHUB_TOKEN');
    expect((getAllByLabelText('Value')[0] as HTMLInputElement).type).toBe('password');
    expect(getByText('Add variable').classList).toContain('cinder-sr-only');
    expect(getByRole('button', { name: 'Remove GITHUB_TOKEN' }).textContent?.trim()).toBe('');
  });

  test('monospace draws both inputs in the code face', () => {
    const { container } = render(KeyValueEditor, {
      entries: [{ id: 'token', key: 'GITHUB_TOKEN', value: 'private' }],
      monospace: true,
    });
    const inputs = container.querySelectorAll('input');
    expect(inputs).toHaveLength(4);
    for (const input of inputs) {
      expect(input.closest('[data-cinder-variant]')?.getAttribute('data-cinder-variant')).toBe(
        'code',
      );
    }
  });
});

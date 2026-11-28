/// <reference lib="dom" />
/**
 * COR-2771: Table's server HTML already carries what its stacked form needs, so the first paint on
 * a phone is the stacked form with no script: each body cell's column label, the card's title and
 * empty marks, the table roles, the attributes CSS reads to choose a form, and, for a custom
 * `stackBelow`, the scoped rule for that length.
 */
import {
  hydrateServerHtml,
  prepareSvelteServerSource,
  renderSvelteOnServer,
  setupHappyDom,
} from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';
import { flushSync } from 'svelte';

import { setTestViewportWidth } from '@lostgradient/component-tooling/test/viewport.ts';

setupHappyDom();

const { render } = await import('@testing-library/svelte');
const { default: ServerFixture } = await import('./table-server.fixture.svelte');

const fixturePath = new URL('./table-server.fixture.svelte', import.meta.url).pathname;

const cardFixturePath = new URL('./table-card.fixture.svelte', import.meta.url).pathname;
await prepareSvelteServerSource(fixturePath);
await prepareSvelteServerSource(cardFixturePath);

// Server rendering spawns a Bun process, so every render runs once at module scope.
const [fit, fitSwitch, fitSelect, controls, plain, custom480, custom20, noStack] =
  await Promise.all([
    renderSvelteOnServer(fixturePath, { shape: 'fit' }),
    renderSvelteOnServer(fixturePath, { shape: 'fit-switch' }),
    renderSvelteOnServer(fixturePath, { shape: 'fit-select' }),
    renderSvelteOnServer(fixturePath, { shape: 'controls' }),
    renderSvelteOnServer(fixturePath, { shape: 'plain' }),
    renderSvelteOnServer(fixturePath, { shape: 'fit', stackBelow: '480px' }),
    renderSvelteOnServer(fixturePath, { shape: 'fit', stackBelow: '20rem' }),
    renderSvelteOnServer(fixturePath, { shape: 'fit', stackBelow: false }),
  ]);
const [sortableCard, unsortableCard] = await Promise.all([
  renderSvelteOnServer(cardFixturePath, { sortable: true }),
  renderSvelteOnServer(cardFixturePath, { sortable: false }),
]);
const invalidLength = await renderSvelteOnServer(fixturePath, {
  shape: 'fit',
  stackBelow: 'url(x)',
}).then(
  () => undefined,
  (error: unknown) => String(error),
);

/** The server HTML parsed into a detached element, to read its attributes. */
function parsed(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  return root;
}

function bodyRows(root: Element): Element[][] {
  return Array.from(root.querySelectorAll('tbody tr'), (row) => Array.from(row.children));
}

describe('Table server HTML', () => {
  test('carries each body cell its column label', () => {
    for (const row of bodyRows(parsed(fit))) {
      expect(row.map((cell) => cell.getAttribute('data-cinder-stack-label'))).toEqual([
        'Namespace',
        'State',
        'Retention',
      ]);
    }
    expect(fit).toContain('data-cinder-stack-label="Namespace"');
    expect(fit).toContain('data-cinder-stack-label="State"');
  });

  test('says which form a table can take, in the attributes CSS reads', () => {
    const shapeOf = (html: string) => {
      const root = parsed(html);
      return {
        fit: root.querySelector('table')?.hasAttribute('data-cinder-fit') ?? false,
        controls: Array.from(root.querySelectorAll('tbody [data-cinder-controls]'), (cell) =>
          cell.getAttribute('data-cinder-controls'),
        ),
        container: root.querySelector('.cinder-table-container > .cinder-table-scroll > table')
          ? 'wrapped'
          : 'bare',
      };
    };
    // Flat rows: `fit`, and a switch that keeps its size does not change that.
    expect(shapeOf(fit)).toEqual({ fit: true, controls: [], container: 'wrapped' });
    expect(shapeOf(fitSwitch)).toEqual({
      fit: true,
      controls: ['fit', 'fit', 'fit'],
      container: 'wrapped',
    });
    // The control layout: `fit` with a control that fills its cell, or any control without `fit`.
    expect(shapeOf(fitSelect)).toEqual({ fit: true, controls: ['', '', ''], container: 'wrapped' });
    expect(shapeOf(controls)).toEqual({
      fit: false,
      controls: ['fit', 'fit', 'fit'],
      container: 'wrapped',
    });
    // Neither: it never stacks.
    expect(shapeOf(plain)).toEqual({ fit: false, controls: [], container: 'wrapped' });
  });

  test('marks the card title and empty cells where script marks them after hydration', () => {
    const marks = (root: Element) =>
      bodyRows(root).map((row) =>
        row.map((cell) =>
          cell.hasAttribute('data-cinder-stack-title')
            ? 'title'
            : cell.hasAttribute('data-cinder-stack-empty')
              ? 'empty'
              : '',
        ),
      );
    const server = marks(parsed(fit));
    // Row one's title is its row header; row two's is its first cell with content. In row three a
    // cell with content comes before the row header and claims the title first, as the server
    // writes it; the card rules give the row header the title over it (table-stack-rules.ts).
    expect(server).toEqual([
      ['title', '', 'empty'],
      ['empty', 'title', ''],
      ['title', 'title', ''],
    ]);
    // A phone-width client render draws cards: the row header takes the title from the earlier
    // cell, and the other marks match the server's.
    setTestViewportWidth(375);
    const client = render(ServerFixture, { shape: 'fit' });
    flushSync();
    expect(client.container.querySelector('table')?.hasAttribute('data-cinder-stack-card')).toBe(
      true,
    );
    expect(marks(client.container)).toEqual([
      ['title', '', 'empty'],
      ['empty', 'title', ''],
      ['', 'title', ''],
    ]);
    client.unmount();
  });

  test('carries the table roles of a table that can stack', () => {
    const root = parsed(fit);
    expect(root.querySelector('table')?.getAttribute('role')).toBe('table');
    expect(
      Array.from(root.querySelectorAll('thead, tbody'), (part) => part.getAttribute('role')),
    ).toEqual(['rowgroup', 'rowgroup']);
    expect(Array.from(root.querySelectorAll('tr'), (row) => row.getAttribute('role'))).toEqual([
      'row',
      'row',
      'row',
      'row',
    ]);
    expect(
      Array.from(root.querySelectorAll('thead th'), (cell) => cell.getAttribute('role')),
    ).toEqual(['columnheader', 'columnheader', 'columnheader']);
    expect(root.querySelector('tbody td')?.getAttribute('role')).toBe('cell');
  });

  test('hydration keeps the roles and labels while the table is wide', async () => {
    setTestViewportWidth(1280);
    const hydrated = hydrateServerHtml(ServerFixture, fit, { shape: 'fit' });
    flushSync();
    try {
      expect(hydrated.warnings).toEqual([]);
      const root = hydrated.container;
      expect(root.querySelector('table')?.hasAttribute('data-cinder-stacked')).toBe(false);
      expect(root.querySelector('table')?.getAttribute('role')).toBe('table');
      expect(root.querySelector('tbody td')?.getAttribute('role')).toBe('cell');
      expect(root.querySelector('tbody td')?.getAttribute('data-cinder-stack-label')).toBe('State');
    } finally {
      await hydrated.cleanup();
    }
  });

  test('a sortable fit table carries its stacked sort control, before the table', () => {
    const root = parsed(sortableCard);
    const sortRow = root.querySelector('.cinder-table__stack-sort');
    expect(sortRow).not.toBeNull();
    // Before hydration the select is disabled and says "Sort by": it names its role, and no one
    // lands on an empty list (design review, round 2).
    const select = sortRow?.querySelector('select');
    expect(select?.disabled).toBe(true);
    expect(select?.selectedOptions[0]?.textContent?.trim()).toBe('Sort by');
    // Before the table, in its scroll box, so the generated rule reads it through a later sibling.
    expect(sortRow?.nextElementSibling?.classList.contains('cinder-table-scroll')).toBe(true);
    expect(parsed(unsortableCard).querySelector('.cinder-table__stack-sort')).toBeNull();
  });

  test('a custom stackBelow brings its scoped rule; false brings none; a bad length throws', () => {
    for (const [html, length] of [
      [custom480, '480px'],
      [custom20, '20rem'],
    ] as const) {
      const root = parsed(html);
      expect(root.querySelector('table')?.getAttribute('data-cinder-stack-below')).toBe(length);
      const style = root.querySelector('style')?.textContent ?? '';
      expect(style).toContain(`@container cinder-table not (min-width: ${length})`);
      expect(style).toContain(`[data-cinder-stack-below="${length}"]`);
    }
    expect(parsed(noStack).querySelector('style')).toBeNull();
    expect(noStack).not.toContain('@container');
    expect(parsed(noStack).querySelector('table')?.getAttribute('data-cinder-stack-below')).toBe(
      'false',
    );
    // The default lengths need no style of their own: table.css holds them.
    expect(parsed(fit).querySelector('style')).toBeNull();
    expect(invalidLength).toContain('Table stackBelow must be a CSS length');
  });
});

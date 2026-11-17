/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { setupHappyDom } from '@lostgradient/testing';

// setupHappyDom() MUST run before any `@testing-library/svelte` import: testing-library reads
// `globalThis.document` at module-init.
setupHappyDom();

const { render, cleanup } = await import('@testing-library/svelte');
const { default: ApprovalGroup } = await import('./approval-group.svelte');
// Imported dynamically so Bun's svelte plugin resolves the client build first.
const { createRawSnippet } = await import('svelte');

afterEach(() => {
  cleanup();
  document.body.replaceChildren();
});

/** Two rows, each its own element, as a host hands them over. */
function rows(...labels: string[]) {
  return createRawSnippet(() => ({
    render: () =>
      `<div>${labels.map((label) => `<div class="row" data-row>${label}</div>`).join('')}</div>`,
  }));
}

describe('ApprovalGroup', () => {
  test('is one group named by its heading, not a landmark, with the rows under the heading', () => {
    const { container, getByRole } = render(ApprovalGroup, {
      heading: '2 approvals waiting',
      children: rows('Refund order 4471', 'Delete draft 12'),
    });

    const group = getByRole('group', { name: '2 approvals waiting' });
    expect(group.classList.contains('cinder-approval-group')).toBe(true);
    expect(container.querySelector('section')).toBeNull();
    const heading = group.querySelector('h3');
    expect(heading?.textContent?.trim()).toBe('2 approvals waiting');
    expect(heading?.nextElementSibling?.classList.contains('cinder-approval-group__rows')).toBe(
      true,
    );
    expect(Array.from(container.querySelectorAll('[data-row]'), (row) => row.textContent)).toEqual([
      'Refund order 4471',
      'Delete draft 12',
    ]);
  });

  test('writes its heading at the level the host gives, and merges a class', () => {
    const { container } = render(ApprovalGroup, {
      heading: '3 approvals waiting',
      headingLevel: 4,
      class: 'host-group',
      children: rows('One'),
    });

    expect(container.querySelector('h4.cinder-approval-group__heading')).not.toBeNull();
    expect(container.querySelector('h3')).toBeNull();
    const group = container.querySelector('.cinder-approval-group');
    expect(group?.classList.contains('host-group')).toBe(true);
  });

  test('draws one border around the rows, and the rows give up their own (no box in a box)', () => {
    const css = readFileSync(join(import.meta.dir, 'approval-group.css'), 'utf8');
    expect(css).toMatch(/\.cinder-approval-group \{[^}]*border: 1px solid var\(--cinder-border\);/);
    expect(css).toMatch(
      /\.cinder-approval-group \.cinder-approval-card--row \{[^}]*border: 0;[^}]*border-radius: 0;/,
    );
    expect(css).toMatch(
      /\.cinder-approval-group__rows > \* \+ \* \{[^}]*border-block-start: 1px solid/,
    );
  });
});

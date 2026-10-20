/**
 * What an approval would run (`bureau-review-operation.svelte`): the `command`, the `diff`, and the
 * `filesTouched` the policy evaluated, each labelled and each shown only when the review carries it.
 */
import { cleanup, fireEvent, render } from '@testing-library/svelte';
import { afterEach, describe, expect, test } from 'bun:test';

import { REVIEWS_COPY } from '../../app/copy.ts';
import BureauReviewOperation from './bureau-review-operation.svelte';

afterEach(cleanup);

const PATCH = `diff --git a/src/cache.ts b/src/cache.ts
--- a/src/cache.ts
+++ b/src/cache.ts
@@ -1,2 +1,2 @@
-cache.set(key, result);
+cache.set(key, result, { ttl: 60 });
 return result;
`;

const mount = (operation: Record<string, unknown>) =>
  render(BureauReviewOperation, { props: { operation: { kind: 'other', ...operation } } } as never);

describe('the operation of an approval', () => {
  test('shows the command as code, under its label', () => {
    const { container, getByText } = mount({
      kind: 'command',
      command: 'rm -rf build && bun run build',
    });
    expect(getByText(REVIEWS_COPY.operation.command)).not.toBeNull();
    expect(container.querySelector('code')?.textContent).toBe('rm -rf build && bun run build');
  });

  test('shows a patch that parses with the source diff viewer, under its label', () => {
    const { container, getByText } = mount({ kind: 'patch', diff: PATCH });
    expect(getByText(REVIEWS_COPY.operation.diff)).not.toBeNull();
    expect(container.querySelector('.cinder-source-diff-viewer')).not.toBeNull();
    expect(container.textContent).toContain('cache.set(key, result, { ttl: 60 });');
  });

  test('shows a diff that does not parse as a preformatted block', () => {
    const { container } = mount({ kind: 'patch', diff: 'not a patch, only words' });
    expect(container.querySelector('.cinder-source-diff-viewer')).toBeNull();
    expect(container.querySelector('pre.weft-bureau-review-operation__diff')?.textContent).toBe(
      'not a patch, only words',
    );
  });

  test('lists the files it touches, under their label', () => {
    const { container, getByText } = mount({
      kind: 'file-write',
      filesTouched: ['src/a.ts', 'src/b.ts'],
    });
    expect(getByText(REVIEWS_COPY.operation.filesTouched)).not.toBeNull();
    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  test('lists a path once when the tool names it twice, as a patch with two hunks in one file does', () => {
    const { container } = mount({
      kind: 'file-write',
      filesTouched: ['src/a.ts', 'src/b.ts', 'src/a.ts'],
    });
    expect(container.textContent).not.toContain('Something went wrong');
    expect([...container.querySelectorAll('li')].map((item) => item.textContent)).toEqual([
      'src/a.ts',
      'src/b.ts',
    ]);
  });

  describe('a patch longer than the viewer shows by default', () => {
    const LONG = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -0,0 +1,1500 @@
${Array.from({ length: 1500 }, (_, index) => `+line-${index + 1}`).join('\n')}
`;

    test('shows the first rows with the viewer’s notice, and not the rest', () => {
      const { container, queryByRole } = mount({ kind: 'patch', diff: LONG });
      expect(container.querySelector('.cinder-source-diff-viewer__notice')?.textContent).toContain(
        'Showing first 1000 of 1500 diff lines.',
      );
      expect(container.textContent).toContain('line-1000');
      expect(container.textContent).not.toContain('line-1001');
      expect(queryByRole('button', { name: REVIEWS_COPY.operation.showWholeDiff })).not.toBeNull();
    });

    test('shows the whole patch when the operator asks, so none of it goes unread', async () => {
      const { container, getByRole, queryByRole } = mount({ kind: 'patch', diff: LONG });
      await fireEvent.click(getByRole('button', { name: REVIEWS_COPY.operation.showWholeDiff }));
      expect(container.textContent).toContain('line-1500');
      expect(container.querySelector('.cinder-source-diff-viewer__notice')).toBeNull();
      expect(queryByRole('button', { name: REVIEWS_COPY.operation.showWholeDiff })).toBeNull();
    });

    test('offers no button for a patch that fits', () => {
      const { queryByRole } = mount({ kind: 'patch', diff: PATCH });
      expect(queryByRole('button', { name: REVIEWS_COPY.operation.showWholeDiff })).toBeNull();
    });
  });

  test('shows all three together when the operation has them', () => {
    const { container } = mount({
      kind: 'command',
      command: 'bun test',
      diff: PATCH,
      filesTouched: ['src/cache.ts'],
    });
    expect(container.textContent).toContain('bun test');
    expect(container.querySelector('.cinder-source-diff-viewer')).not.toBeNull();
    expect(container.querySelectorAll('li').length).toBe(1);
  });

  test('shows nothing for an operation that carries none of them', () => {
    const { container } = mount({});
    expect(container.textContent?.trim()).toBe('');
    expect(container.querySelector('code, pre, ul')).toBeNull();
  });
});

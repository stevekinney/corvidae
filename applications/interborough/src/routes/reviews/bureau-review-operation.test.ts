/**
 * What an approval would run (`bureau-review-operation.svelte`): the `command`, the `diff`, and the
 * `filesTouched` the policy evaluated, each labelled and each shown only when the review carries it.
 */
import { cleanup, render } from '@testing-library/svelte';
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

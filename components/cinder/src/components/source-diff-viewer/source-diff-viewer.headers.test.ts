/// <reference lib="dom" />
import { afterEach, describe, expect, test } from 'bun:test';

import { setupHappyDom } from '@lostgradient/testing';

setupHappyDom();

const { cleanup, render } = await import('@testing-library/svelte');
const { default: SourceDiffViewer } = await import('./index.ts');

afterEach(() => cleanup());

const patch = [
  '--- a/instructions.md',
  '+++ b/instructions.md',
  '@@ -1,3 +1,3 @@',
  ' You handle refund requests.',
  '-Always answer within two sentences.',
  '+Answer in as many sentences as the question needs.',
  ' Escalate refunds over $100 to a person.',
  '',
].join('\n');

describe('SourceDiffViewer: headers', () => {
  test('draws each file’s header and each hunk’s header by default', () => {
    const { container } = render(SourceDiffViewer, { patch });
    expect(
      container.querySelector('.cinder-source-diff-viewer__file-header')?.textContent,
    ).toContain('instructions.md');
    expect(container.querySelector('.cinder-source-diff-viewer__hunk-header')?.textContent).toBe(
      '@@ -1,3 +1,3 @@',
    );
  });

  test('headers={false} leaves out both and keeps every row and the named regions', () => {
    const { container, getByRole } = render(SourceDiffViewer, {
      patch,
      headers: false,
      ariaLabel: 'Instructions',
    });
    expect(container.querySelector('.cinder-source-diff-viewer__file-header')).toBeNull();
    expect(container.querySelector('.cinder-source-diff-viewer__hunk-header')).toBeNull();
    expect(container.querySelectorAll('.cinder-source-diff-viewer__line')).toHaveLength(4);
    expect(getByRole('region', { name: 'Instructions' })).not.toBeNull();
    expect(container.querySelector('section[aria-label]')?.getAttribute('aria-label')).toContain(
      'instructions.md',
    );
  });

  test('a truncated patch still counts and offers Show all without its headers', () => {
    const { getByRole, container } = render(SourceDiffViewer, {
      patch,
      headers: false,
      maxLines: 2,
    });
    expect(container.textContent).toContain('Showing');
    expect(getByRole('button', { name: 'Show all' })).not.toBeNull();
  });
});

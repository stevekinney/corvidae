import { renderSvelteOnServer } from '@lostgradient/testing';
import { describe, expect, test } from 'bun:test';

const fixturePath = new URL('./list-detail.fixture.svelte', import.meta.url).pathname;
// Server rendering spawns a Bun process, so it runs once at module scope, off bun's per-test clock.
const html = await renderSvelteOnServer(fixturePath);

describe('ListDetail SSR contract', () => {
  test('renders the rows, the header and the empty detail without a window', () => {
    expect(html).toContain('cinder-list-detail');
    expect(html).toContain('Alpha chat');
    expect(html).toContain('Gamma chat');
    expect(html).toContain('Search chats');
    expect(html).toContain('Nothing selected');
  });

  test('renders the wide layout, never the stacked one, before the width is measured', () => {
    expect(html).toContain('data-cinder-layout="split"');
    expect(html).not.toContain('data-cinder-layout="stacked"');
    expect(html).not.toContain('cinder-list-detail__back');
  });
});

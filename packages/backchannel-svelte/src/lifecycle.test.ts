import { setupHappyDom, sveltePlugin, waitUntil } from '@lostgradient/testing';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

it('runs the generated Svelte fixture with reactive reads, scope teardown and seed hydration', async () => {
  setupHappyDom();
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    observe() {}
    disconnect() {}
  } as unknown as typeof IntersectionObserver;
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../tests/fixture/browser-driver.ts', import.meta.url))],
    target: 'browser',
    plugins: [sveltePlugin({ generate: 'client' })],
  });
  expect(build.success).toBe(true);
  const source = await build.outputs[0].text();
  const driver = await import(
    `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  );
  const target = document.createElement('div');
  document.body.append(target);
  const component = driver.mountFixture(target);
  const text = (id: string) => target.querySelector(`[data-testid="${id}"]`)?.textContent;
  const click = (label: string) => {
    const button = [...target.querySelectorAll('button')].find(
      (entry) => entry.textContent === label,
    );
    if (!button) throw new Error(`Missing button ${label}`);
    button.click();
    driver.flushSync();
  };
  try {
    await waitUntil(() => text('read') === 'a-first');
    expect(text('hydration')).toBe('one');
    expect(text('hydration-reads')).toBe('0');
    expect(text('writes')).toBe('0');
    click('Connect events');
    await waitUntil(() => text('events') === 'one,two');
    click('Connect events');
    await waitUntil(() => text('cursors') === 'start,2');
    expect(text('events')).toBe('one,two');
    window.dispatchEvent(new Event('online'));
    driver.flushSync();
    expect(text('writes')).toBe('0');
    click('Initial fault');
    await waitUntil(() => text('initial-error') === 'read failed');
    expect(text('refresh-error')).toBe('');
    click('Change input');
    await waitUntil(() => text('read') === 'a-second');
    click('Fail next refresh');
    click('Refresh');
    await waitUntil(() => text('refresh-error') === 'read failed');
    expect(text('initial-error')).toBe('');
    click('Start late read');
    await waitUntil(() => text('late-started') === 'true');
    click('Change input');
    await waitUntil(() => text('read') === 'a-second');
    expect(text('aborted')).toBe('1');
    click('Resolve late read');
    expect(text('read')).toBe('a-second');
    click('Submit delayed');
    expect(text('writes')).toBe('1');
    click('Change scope');
    await waitUntil(() => text('read') === 'b-second');
    expect(text('observer-disconnects')).toBe('1');
    expect(text('streams-aborted')).toBe('2');
    click('Resolve delayed command');
    await Promise.resolve();
    driver.flushSync();
    expect(text('secret')).toBe('');
    click('Submit');
    await waitUntil(() => text('secret') === 'synthetic-once-secret');
    click('Inspect state');
    expect(text('inspection')).not.toContain('synthetic-once-secret');
    expect(text('inspection')).not.toContain('stale-secret');
    expect(text('writes')).toBe('2');
  } finally {
    await driver.unmount(component);
    target.remove();
    globalThis.IntersectionObserver = original;
  }
});

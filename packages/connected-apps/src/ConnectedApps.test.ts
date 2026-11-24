import { setupHappyDom, sveltePlugin, waitUntil } from '@lostgradient/testing';
import { expect, test } from 'bun:test';
import { fileURLToPath } from 'node:url';

test('shows approval details and asks before disconnecting', async () => {
  setupHappyDom();
  const build = await Bun.build({
    entrypoints: [fileURLToPath(new URL('../tests/fixture/browser-driver.ts', import.meta.url))],
    target: 'browser',
    plugins: [sveltePlugin({ generate: 'client' })],
  });
  expect(build.success).toBe(true);
  const driver = await import(
    `data:text/javascript;base64,${Buffer.from(await build.outputs[0].text()).toString('base64')}`
  );
  const target = document.createElement('div');
  document.body.append(target);
  const component = driver.mountFixture(target);
  const click = (label: string) => {
    const button = [...target.querySelectorAll('button')].find(
      (entry) => entry.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Missing ${label}`);
    button.click();
    driver.flushSync();
  };
  try {
    await waitUntil(() => target.textContent?.includes('Claude') ?? false);
    expect(target.textContent).toContain('Read assets');
    click('Disconnect');
    await waitUntil(
      () => target.textContent?.includes('This approval will no longer grant access.') ?? false,
    );
    click('Cancel');
    expect(target.querySelector('[data-testid="writes"]')?.textContent).toBe('0');
    await waitUntil(() => !target.querySelector('dialog[open]'));
    click('Disconnect');
    await waitUntil(
      () => target.textContent?.includes('This approval will no longer grant access.') ?? false,
    );
    const confirm = [...target.querySelectorAll('dialog button')].find(
      (entry) => entry.textContent?.trim() === 'Disconnect',
    );
    if (!confirm) throw new Error('Missing confirmation button');
    confirm.click();
    driver.flushSync();
    await waitUntil(() => target.textContent?.includes('App disconnected.') ?? false);
    expect(target.querySelector('[data-testid="writes"]')?.textContent).toBe('1');
  } finally {
    await driver.unmount(component);
    target.remove();
  }
});

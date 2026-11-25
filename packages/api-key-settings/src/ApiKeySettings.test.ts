import { setupHappyDom, sveltePlugin, waitUntil } from '@lostgradient/testing';
import { expect, it } from 'bun:test';
import { fileURLToPath } from 'node:url';

it('drops one-time values and reconciles an uncertain write exactly once', async () => {
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
      (item) => item.textContent?.trim() === label,
    );
    if (!button) throw new Error(`Missing button ${label}`);
    button.click();
    driver.flushSync();
  };
  const value = (name: string) => target.querySelector(`[data-testid="${name}"]`)?.textContent;
  const issue = () => {
    const input = target.querySelector<HTMLInputElement>('#api-key-label')!;
    input.value = 'sync';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const select = target.querySelector('select')!;
    select.value = 'service';
    select.dispatchEvent(new Event('change', { bubbles: true }));
    driver.flushSync();
    target
      .querySelector('form')!
      .dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    driver.flushSync();
  };
  try {
    await waitUntil(() => target.querySelector('form') !== null);
    issue();
    await waitUntil(() => target.textContent?.includes('secret-value') ?? false);
    const writesWhileSecretVisible = Number(value('writes'));
    issue();
    expect(Number(value('writes'))).toBe(writesWhileSecretVisible);
    click('Inspect caches');
    expect(value('cache')).toContain('service');
    expect(value('cache')).not.toContain('secret-value');
    click('Dismiss');
    expect(target.textContent).not.toContain('secret-value');
    await waitUntil(() => target.textContent?.includes('sync') ?? false);
    const readsBeforeRemount = Number(value('reads'));
    click('Toggle page');
    click('Toggle page');
    await waitUntil(() => target.querySelector('form') !== null);
    expect(Number(value('reads'))).toBe(readsBeforeRemount);
    expect(target.textContent).toContain('sync');
    click('Delay response');
    const writesBeforePending = Number(value('writes'));
    issue();
    await waitUntil(() => Number(value('writes')) === writesBeforePending + 1);
    issue();
    click('Rotate');
    expect(Number(value('writes'))).toBe(writesBeforePending + 1);
    click('Resolve response');
    await waitUntil(() => target.textContent?.includes('late-secret') ?? false);
    issue();
    click('Rotate');
    expect(Number(value('writes'))).toBe(writesBeforePending + 1);
    click('Dismiss');
    click('Revoke');
    await waitUntil(() => target.textContent?.includes('Revoke sync') ?? false);
    click('Cancel');
    expect(Number(value('writes'))).toBe(writesBeforePending + 1);
    click('Revoke');
    await waitUntil(() => target.textContent?.includes('Revoke sync') ?? false);
    click('Revoke key');
    await waitUntil(() => Number(value('writes')) === writesBeforePending + 2);
    issue();
    await waitUntil(() => target.textContent?.includes('secret-value') ?? false);
    click('Change authority');
    expect(target.textContent).not.toContain('secret-value');
    await waitUntil(() => target.querySelector('form') !== null);
    click('Inspect caches');
    expect(value('cache')).not.toContain('["backchannel","A"');
    click('Delay response');
    const writesBeforeDelay = Number(value('writes'));
    issue();
    await waitUntil(() => Number(value('writes')) === writesBeforeDelay + 1);
    click('Change authority');
    click('Resolve response');
    await waitUntil(() => value('delivered') === 'true');
    await Promise.resolve();
    driver.flushSync();
    expect(target.textContent).not.toContain('late-secret');
    await waitUntil(() => target.querySelector('form') !== null);
    click('Lose response');
    const beforeReads = Number(value('reads'));
    const beforeWrites = Number(value('writes'));
    issue();
    await waitUntil(() => target.textContent?.includes('outcome is uncertain') ?? false);
    await waitUntil(() => Number(value('reads')) === beforeReads + 1);
    expect(Number(value('writes'))).toBe(beforeWrites + 1);
    expect(target.textContent).not.toContain('secret-value');
  } finally {
    await driver.unmount(component);
    target.remove();
  }
});

import { describe, expect, test } from 'bun:test';

describe('page bundle hydration policy', () => {
  test('starts hydration eagerly and never uses scrolling as the trigger', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).not.toContain("window.addEventListener('scroll'");
    expect(source).toContain('void hydratePage().catch');
  });

  test('does not replay early interactions until the overview preview is interactive', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();
    const waitForPreview = source.indexOf('await overviewPreviewReady');
    const markPageHydrated = source.indexOf('pageHydrated = true', waitForPreview);

    expect(source).toContain('onOverviewPreviewSettled: () => resolveOverviewPreview?.()');
    expect(waitForPreview).toBeGreaterThan(-1);
    expect(markPageHydrated).toBeGreaterThan(waitForPreview);
  });

  test('exposes when the documentation page owns interactive controls', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();
    const hydrateComponent = source.indexOf('svelte.hydrate(ComponentPage');
    const markControlsHydrated = source.indexOf('markPageControlsHydrated()', hydrateComponent);
    const waitForPreview = source.indexOf('await overviewPreviewReady', hydrateComponent);

    expect(source).toContain("target.setAttribute('data-playground-controls-hydrated', '')");
    expect(markControlsHydrated).toBeGreaterThan(hydrateComponent);
    expect(markControlsHydrated).toBeLessThan(waitForPreview);
    expect(source).toContain(
      "pageControlsHydrated && element.closest('[data-overview-preview-rendered]') === null",
    );
  });

  test('re-resolves an early button against the interactive tree before replaying it', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain('const buttonLocation = elementLocation(button)');
    expect(source).toContain('const hydratedButton = resolveElementLocation(buttonLocation)');
    expect(source).not.toContain('hydrateAfter(event, () => button.click())');
  });

  test('re-resolves early tabs and composite widgets before replaying keyboard navigation', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain('[role="tab"], [role="grid"], [role="listbox"]');
    expect(source).toContain('const keyboardTargetLocation = elementLocation(keyboardTarget)');
    expect(source).toContain('resolveElementLocation(keyboardTargetLocation)?.dispatchEvent');
    expect(source).not.toContain('button.dispatchEvent');
  });

  test('leaves native form-control keyboard behavior to the browser before hydration', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain("eventTarget.closest('input, textarea, select') !== null");
    expect(source).not.toContain('[role="treegrid"], input, textarea, select');
  });

  test('re-resolves hash anchors before replaying activation', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain('const anchorLocation = elementLocation(anchor)');
    expect(source).toContain('const hydratedAnchor = resolveElementLocation(anchorLocation)');
    expect(source).not.toContain('hydrateAfter(event, () => anchor.click())');
  });

  test('preserves checked state and change semantics when replaying form input', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain("['checkbox', 'radio'].includes(input.type)");
    expect(source).toContain('hydratedInput.checked = checked');
    expect(source).toContain("new Event('change', { bubbles: true })");
  });

  test('replays select values and change semantics against the hydrated control', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain('input instanceof HTMLSelectElement');
    expect(source).toContain('hydratedInput instanceof HTMLSelectElement');
    expect(source).toContain('checked !== undefined || hydratedInput instanceof HTMLSelectElement');
  });

  test('reuses the rendered overview instead of embedding a duplicate HTML payload', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source).toContain(".querySelector<HTMLElement>('[data-overview-preview-rendered]')");
    expect(source).toContain('.innerHTML.replace(pageHtmlBlockMarker');
    expect(source).toContain(".replace(svelteHydrationMarker, '')");
    expect(source).not.toContain('__CINDER_OVERVIEW_EXAMPLE_HTML__');
  });

  test('exposes an idempotent boot and an unmount that release everything boot added', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    // The contract the navigator relies on: one registered page object with boot and unmount.
    expect(source).toContain('const page = { boot, unmount };');
    expect(source).toContain("['__CINDER_PAGE__'] = page");
    // boot() is idempotent: a second call returns the run that is already active.
    expect(source).toContain('if (activeRun !== undefined) return activeRun.ready;');
    // Every document listener boot adds shares one AbortController, and unmount aborts it.
    const documentListeners = source.match(/document\.addEventListener\(/g) ?? [];
    const signalledOptions = source.match(/\{ capture: true, signal: listeners\.signal \}/g) ?? [];
    expect(documentListeners.length).toBeGreaterThan(0);
    expect(signalledOptions).toHaveLength(documentListeners.length);
    expect(source).toContain('listeners.abort();');
    // unmount releases the Svelte instance that hydrate or mount returned.
    expect(source).toContain('instance = svelte.hydrate(ComponentPage');
    expect(source).toContain('instance = svelte.mount(ComponentPage');
    expect(source).toContain('await svelte.unmount(instance)');
    expect(source).toContain(
      "delete (window as unknown as Record<string, unknown>)['__CINDER_SCENARIO_LOADERS__']",
    );
  });

  test('boots once when the module is evaluated and installs navigation once', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();

    expect(source.match(/\nvoid boot\(\)\.catch/g) ?? []).toHaveLength(1);
    expect(source.match(/\ninstallProgressiveNavigation\(\);/g) ?? []).toHaveLength(1);
    expect(source).toContain(
      "import { installProgressiveNavigation } from '../../src/shell-app/progressive-navigation.ts';",
    );
  });

  test('unmount never waits on a hydration that is still loading its modules', async () => {
    const source = await Bun.file(new URL('./page-bundle.ts', import.meta.url)).text();
    const unmountStart = source.indexOf('unmount: async () => {');
    const unmountBody = source.slice(unmountStart, source.indexOf('\n  },', unmountStart));

    expect(source).toContain('let disposed = false;');
    expect(source).toContain('if (disposed) return;');
    expect(unmountBody).toContain('disposed = true;');
    expect(unmountBody).not.toContain('await ready');
  });
});

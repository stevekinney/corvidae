/** The happy-dom window size `setupHappyDom` starts every test file with. */
export const DEFAULT_TEST_VIEWPORT = { width: 1024, height: 768 } as const;

type HappyDomControls = { setViewport(viewport: { width: number; height: number }): void };

function readHappyDomControls(): HappyDomControls {
  const controls: unknown = Reflect.get(window, 'happyDOM');
  if (
    typeof controls !== 'object' ||
    controls === null ||
    typeof Reflect.get(controls, 'setViewport') !== 'function'
  ) {
    throw new Error('setTestViewportWidth needs the happy-dom window from setupHappyDom().');
  }
  return controls as HappyDomControls;
}

/**
 * Resizes the shared happy-dom window, which re-evaluates every `MediaQueryList`
 * and fires its `change` event. Restore `DEFAULT_TEST_VIEWPORT` in a teardown
 * hook, because every later test file shares this window.
 */
export function setTestViewportWidth(width: number): void {
  readHappyDomControls().setViewport({ width, height: DEFAULT_TEST_VIEWPORT.height });
}

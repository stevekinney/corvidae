import { BROWSER } from 'esm-env';

import { createRendererEngine, type RendererEngineFactory } from './terminal-engine-adapter.ts';

/**
 * Load the selected engine and its fit helper, and return the factory that constructs it. This is
 * the only place either package is imported, and it imports them dynamically, so evaluating the
 * package on a server never loads an engine and a client loads it only when a terminal actually
 * mounts. Loading constructs nothing: the caller calls the factory after it has checked that it
 * still wants an engine.
 */
export async function loadRendererEngineFactory(
  inBrowser: boolean = BROWSER,
): Promise<RendererEngineFactory> {
  if (!inBrowser) throw new Error('The terminal engine loads only in a browser.');
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import('@xterm/xterm'),
    import('@xterm/addon-fit'),
  ]);
  return (options) => createRendererEngine({ Terminal, FitAddon }, options);
}

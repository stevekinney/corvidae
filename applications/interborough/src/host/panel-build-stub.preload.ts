/**
 * The host test lane's default panel build (COR-2219), named in `bunfig.toml` as a `bun test`
 * preload. A host a test starts mounts every default plugin's panels, and a real build of them is
 * about eight seconds in a process nothing has built in; under `--parallel` every test file is such
 * a process. This replaces `hostPanelMountOptions` with one that builds the page of
 * `panel-build-stub.test-support.ts` unless the test passes its own `panelBuild.build`, which
 * always wins. Production code is untouched: it reads the same module without the preload.
 */
import { mock } from 'bun:test';
import { fileURLToPath } from 'node:url';

import { stubPanelBuild } from './panel-build-stub.test-support.ts';

const location = fileURLToPath(new URL('./panel-mount-options.ts', import.meta.url));
// A copy of the exports, taken before the mock replaces them: the module's own namespace is live.
const original = { ...(await import('./panel-mount-options.ts')) };

await mock.module(location, () => ({
  ...original,
  hostPanelMountOptions: (
    options: Parameters<typeof original.hostPanelMountOptions>[0],
  ): ReturnType<typeof original.hostPanelMountOptions> =>
    original.hostPanelMountOptions({
      ...options,
      overrides: { build: stubPanelBuild, ...options.overrides },
    }),
}));

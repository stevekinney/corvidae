import type { ElectrobunConfig } from 'electrobun';

import { prebundledMainRequested } from './scripts/environment-configuration.ts';

// Set only by the `build` and `build:stable` scripts, after
// `scripts/bundle-main-process.ts` has written the file below. Keep the path in
// step with `mainProcessBundlePath` there; a unit test enforces it.
const prebundledMainEntrypoint = '.main-bundle/index.js';

/**
 * `mainProcess: "bun"` rather than the 2.x default of Cottontail.
 *
 * The chat turn runs `@lostgradient/operative` and the Anthropic SDK in the main
 * process, and those are Bun-targeted workspace sources compiled straight from
 * TypeScript. Bun is the runtime this workspace builds everything else against,
 * so the main process stays on it rather than becoming the one place that has
 * to be portable to a second JavaScript runtime.
 */
export default {
  app: {
    name: 'Corvidae Desktop',
    identifier: 'net.lostgradient.corvidae.desktop',
    version: '0.0.1',
  },
  build: {
    mainProcess: 'bun',
    bun: {
      // Under `build` this is a file Bun already bundled, not the source
      // entrypoint. Electrobun bundles this entry with Cottontail's native
      // `Bun.build`, which segfaults intermittently on the main-process graph
      // (COR-1389, blackboardsh/electrobun#564: 12 of 960 runs; 0 of 960 when
      // Cottontail is handed the one pre-bundled file). `dev` keeps the source
      // entrypoint so `electrobun dev --watch` still rebuilds on main-process edits.
      entrypoint: prebundledMainRequested() ? prebundledMainEntrypoint : 'src/bun/index.ts',
    },
    // Vite builds the renderer into `dist/`; Electrobun copies it into the
    // bundle under the `views://mainview` origin the window loads.
    copy: {
      'dist/index.html': 'views/mainview/index.html',
      'dist/assets': 'views/mainview/assets',
    },
    // HMR owns renderer rebuilds in development; watching Vite's output would
    // restart the application on every one of them.
    watchIgnore: ['dist/**'],
    mac: { bundleCEF: false },
    linux: { bundleCEF: false },
    win: { bundleCEF: false },
  },
} satisfies ElectrobunConfig;

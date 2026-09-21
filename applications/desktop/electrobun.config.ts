import type { ElectrobunConfig } from 'electrobun';

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
      entrypoint: 'src/bun/index.ts',
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

import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DashboardAssets, DashboardRouteTarget } from '@repo/weft';

const DEFAULT_CONSOLE_BUILD_DIRECTORY = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../weft-console/build',
);

export interface ConsoleMount {
  dashboard: DashboardRouteTarget;
  dashboardAssets: DashboardAssets;
}

function consoleError(message: string): Error {
  return new Error(`--console ${message}`);
}

export interface ConsoleMountOptions {
  buildDirectory?: string;
}

/** Load the locally built console directly from its application output. */
export function loadConsoleMount(options: ConsoleMountOptions = {}): ConsoleMount {
  const buildDirectory = resolve(options.buildDirectory ?? DEFAULT_CONSOLE_BUILD_DIRECTORY);
  const indexPath = join(buildDirectory, 'index.html');
  const assetsDirectory = join(buildDirectory, 'assets');

  try {
    if (!statSync(indexPath).isFile() || !statSync(assetsDirectory).isDirectory()) {
      throw new Error('missing build output');
    }
  } catch {
    throw consoleError(
      `requires a built console at ${buildDirectory}; run bun run --filter=@repo/weft-console build or pass --console-path`,
    );
  }

  return {
    dashboard: new Response(Bun.file(indexPath), {
      headers: { 'content-type': 'text/html; charset=utf-8' },
    }),
    dashboardAssets: { prefix: '/assets', directory: assetsDirectory },
  };
}

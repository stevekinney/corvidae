#!/usr/bin/env bun

/**
 * Generates the typed Bureau client the browser calls (`src/lib/generated/`) from the operations
 * `createBureauHandler` serves, by way of the generic generator in `@lostgradient/backchannel`.
 * Run it with `bun run generate:bureau-client` after a Bureau operation changes; the test beside
 * this file fails when the committed files differ from what it would write.
 */

import { mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { format, resolveConfig } from 'prettier';

import {
  createOperationClientSources as createCatalogOperationClientSources,
  type OperationClientOptions,
} from '@lostgradient/backchannel/generator';
import { createBureauCatalogSnapshot } from '@lostgradient/bureau';

/** Where the generated client is checked in, relative to the application. */
export const BUREAU_CLIENT_DIRECTORY = join(
  dirname(fileURLToPath(import.meta.url)),
  '..',
  'src',
  'lib',
  'generated',
);

export const BUREAU_CLIENT_FILE = 'bureau-operation-client.generated.ts';

/**
 * Bureau's values for the generic generator. Calls go to the composed `/jsonrpc` endpoint of the
 * host and subscriptions to `/bureau/v1/subscriptions`, both under the one base URL the host is
 * served from, through a transport that keeps the write guard and the fault mapping
 * (`src/lib/bureau-transport.ts`).
 */
const operationClientOptions: OperationClientOptions = {
  packageName: '@lostgradient/bureau',
  serverName: 'Bureau',
  factoryName: 'createBureauClient',
  outputDirectory: BUREAU_CLIENT_DIRECTORY,
  outputFile: BUREAU_CLIENT_FILE,
  subscriptions: 'generic',
  subscriptionRoutes: { pathPrefix: '/bureau/v1/subscriptions' },
  examples: {
    list: 'bureau.tasks.list',
    callable: 'bureau.tasks.get',
    cancel: 'bureau.tasks.get',
    subscription: 'bureau.events',
  },
  connection: {
    typeName: 'BureauClientConnection',
    transportName: 'bureauTransport',
    importSpecifier: '../bureau-transport.ts',
    description: [
      'Pass the base URL of the host, which is empty for the origin of the page. Every call is',
      'posted to its `/jsonrpc` endpoint after the write guard has been asked.',
    ],
    example: "{ baseUrl: '' }",
  },
  format: async (contents, filePath) => {
    const configuration = await resolveConfig(filePath);
    return format(contents, { ...configuration, filepath: filePath });
  },
};

/** The generated files of the live Bureau catalog, by file name. */
export function createBureauClientSources(): Promise<ReadonlyMap<string, string>> {
  return createCatalogOperationClientSources(createBureauCatalogSnapshot(), operationClientOptions);
}

/**
 * The command behind `bun scripts/generate-bureau-client.ts`: writes each generated file to
 * `--output-directory` (the checked-in {@link BUREAU_CLIENT_DIRECTORY} by default) and reports one
 * `wrote <path>` line per file. Exported so a test runs it in process.
 */
export async function runGenerateBureauClientCommand(
  args: readonly string[],
  log: (line: string) => void = console.log,
): Promise<void> {
  const { values } = parseArgs({
    args: [...args],
    options: { 'output-directory': { type: 'string' } },
    strict: true,
  });
  const directory = values['output-directory'] ?? BUREAU_CLIENT_DIRECTORY;
  const sources = await createBureauClientSources();
  await mkdir(directory, { recursive: true });
  for (const [fileName, source] of sources) {
    const path = join(directory, fileName);
    await Bun.write(path, source);
    log(`wrote ${path}`);
  }
}

if (import.meta.main) await runGenerateBureauClientCommand(Bun.argv.slice(2));

#!/usr/bin/env bun
// Usage:
//   bun scripts/chef/ci-evidence-run.ts --request <file> --state-directory <dir> [--ref <branch>]
// Exit 0 for bound, 1 for pending/failed/ambiguous, 2 for invalid input or configuration.
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { resolve } from 'node:path';

import { createGitHubCiEvidenceProvider } from './ci-evidence-github.ts';
import {
  createCiEvidenceStore,
  reconcileCiEvidenceRequest,
  type CiEvidenceProvider,
  type CiEvidenceRequest,
} from './ci-evidence.ts';
import { createExecutionStateStore } from './execution-state.ts';
import { parseOptions, requireOption, UsageError } from './process-runner.ts';

/** Reconcile one coordinator-pinned request and emit the run or compact pending state. */
export async function runCiEvidence(
  argv: string[],
  provider?: CiEvidenceProvider,
): Promise<{ code: number; output: string }> {
  const parsed = parseOptions(argv, { values: ['request', 'state-directory', 'ref'] });
  if (parsed.positionals.length > 0) throw new UsageError('Unexpected CI evidence argument');
  const request: CiEvidenceRequest = JSON.parse(
    readFileSync(requireOption(parsed, 'request'), 'utf8'),
  );
  const stateDirectory = resolve(requireOption(parsed, 'state-directory'));
  const dispatchRef = parsed.values['ref'];
  if (request.event === 'workflow_dispatch' && dispatchRef === undefined)
    throw new UsageError('--ref is required for a manual CI evidence request');

  const state = createExecutionStateStore({ stateDirectory, hostId: hostname() });
  const result = await reconcileCiEvidenceRequest(
    createCiEvidenceStore(state),
    request,
    provider ??
      createGitHubCiEvidenceProvider({
        repository: request.repository,
        ...(dispatchRef === undefined ? {} : { dispatchRef }),
      }),
  );
  return { code: result.state === 'bound' ? 0 : 1, output: JSON.stringify(result) };
}

if (import.meta.main) {
  try {
    const result = await runCiEvidence(Bun.argv.slice(2));
    process.stdout.write(result.output + '\n');
    process.exitCode = result.code;
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + '\n');
    process.exitCode = 2;
  }
}

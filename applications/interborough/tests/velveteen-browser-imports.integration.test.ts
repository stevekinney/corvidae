import { expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { buildProduction } from '@lostgradient/velveteen/build';
import { getNextCronOccurrence } from '@lostgradient/weft/client';

it('builds public browser imports and rejects a server-only import', async () => {
  expect(
    getNextCronOccurrence('30 2 * * *', Date.parse('2026-03-08T08:00:00Z'), {
      timeZone: 'America/Los_Angeles',
    }),
  ).toBe(Date.parse('2026-03-09T09:30:00Z'));
  const parent = process.env['COR_2762_SCRATCH'] ?? resolve(import.meta.dir, '../../../tmp');
  await mkdir(parent, { recursive: true });
  const project = await mkdtemp(join(parent, 'velveteen-browser-imports-'));
  const routes = join(project, 'routes');
  await mkdir(routes);
  await symlink(resolve(import.meta.dir, '../node_modules'), join(project, 'node_modules'));
  const route = join(routes, '+page.svelte');
  const build = () =>
    buildProduction({
      projectDirectory: project,
      routesDirectory: routes,
      outputDirectory: join(project, 'output'),
    });
  try {
    await writeFile(
      route,
      `<script>
      import { HttpClient, HttpClientError, isWeftFault, REGISTRY_VERSION, parseWorkflowRevisionManifest, activityContractHash, selectWorkerDeployment, getNextCronOccurrence, WEFT_RESERVED_KEY_PREFIXES, WORKER_CONFLICT_REASONS, UPGRADE_REFUSAL_REASON_PREFIX, WorkflowStartedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowSuspendedEvent, WorkflowResumedEvent, WorkflowTimedOutEvent } from '@lostgradient/weft/client';
      import { parkedHumanWait } from '@lostgradient/operative/human-wait-parks';
      import { parseStepRowIdentifier } from '@lostgradient/operative/message-identifiers';
      const values = [HttpClient, HttpClientError, isWeftFault, REGISTRY_VERSION, parseWorkflowRevisionManifest, activityContractHash, selectWorkerDeployment, getNextCronOccurrence, WEFT_RESERVED_KEY_PREFIXES, WORKER_CONFLICT_REASONS, UPGRADE_REFUSAL_REASON_PREFIX, WorkflowStartedEvent, WorkflowCompletedEvent, WorkflowFailedEvent, WorkflowCancelledEvent, WorkflowSuspendedEvent, WorkflowResumedEvent, WorkflowTimedOutEvent, parkedHumanWait, parseStepRowIdentifier];
    </script><p>{values.length}</p>`,
    );
    await build();
    await writeFile(
      route,
      `<script>import { Engine } from '@lostgradient/weft';</script><p>{Engine.name}</p>`,
    );
    let failure: unknown;
    try {
      await build();
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).errors.map(String).join('\n')).toContain(
      'Server-only module',
    );
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

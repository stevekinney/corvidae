/**
 * The runs a plugin's agents have in flight, read when a person presses the switch to turn the
 * plugin off (COR-2235), so the confirmation can name the work the restart will fail: a run of a
 * plugin's agent that a restart recovers while the plugin is off settles failed with
 * `definition-drifted` (`src/host/plugin-disable-in-flight.slow.test.ts`).
 *
 * The read is a snapshot, taken once as the question opens. A plugin that adds no agent has no
 * such run and is not read. A read that fails is `unknown`, which the dialog says in words: turning
 * a plugin off is never blocked on a read.
 */
import type { QueryClient } from '@tanstack/svelte-query';

import { getContext } from '../../../lib/bureau-client.ts';
import { listInFlightTasks, type TaskView } from '../../../lib/bureau-tasks.ts';
import type { PluginStanding } from '../../../lib/host-plugins.ts';
import { queryKeys } from '../../../lib/query.ts';
import { identifierOf, NAMED_RUNS, NO_RUNS, type InFlightRuns } from './plugin-presentation.ts';

/** The agents the plugin adds, by the identifier a run names them by. */
export function agentsOf(plugin: PluginStanding): ReadonlySet<string> {
  return new Set(
    plugin.contributions
      .filter((entry) => entry.kind === 'agent')
      .map((entry) => identifierOf(entry.id)),
  );
}

/** A run's name: its chat's title when the Bureau has one, else its identifier. */
async function nameOfRun(task: TaskView): Promise<string> {
  try {
    const context = await getContext(task.contextId);
    const title = context.title?.trim();
    return title === undefined || title === '' ? task.id : title;
  } catch {
    return task.id;
  }
}

/**
 * Reads the runs `plugin`'s agents have in flight. The first {@link NAMED_RUNS} are named by their
 * chat's title; the rest are only counted.
 */
export async function readInFlightRuns(
  queryClient: QueryClient,
  plugin: PluginStanding,
): Promise<InFlightRuns> {
  const agents = agentsOf(plugin);
  if (agents.size === 0) return NO_RUNS;
  try {
    const tasks = await queryClient.fetchQuery({
      queryKey: queryKeys.hostPluginRuns(plugin.descriptor.name),
      queryFn: ({ signal }) => listInFlightTasks(agents, { signal }),
      staleTime: 0,
      retry: false,
    });
    const named = await Promise.all(tasks.slice(0, NAMED_RUNS).map(nameOfRun));
    return {
      kind: 'listed',
      runs: tasks.map((task, index) => ({
        id: task.id,
        name: named[index] ?? task.id,
        waiting: task.openWaits.length > 0,
      })),
    };
  } catch {
    return { kind: 'unknown' };
  }
}

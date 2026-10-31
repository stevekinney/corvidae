<script lang="ts">
  /**
   * Worker transport conformance (COR-160). The server operator registers
   * worker commands at startup (`serve({ conformanceTargets })`); this panel
   * lists those targets and, for an admin, runs one. A run executes the
   * protocol check sequence (register, task completion, heartbeat,
   * cancellation, reconnect, revision echo, graceful shutdown) against that
   * command inside a private sandbox server, so it says whether a worker
   * implementation conforms, not what any connected fleet worker is doing.
   * The dashboard names a target and never supplies a command.
   *
   * Every verdict is spelled out in text; the badges add color, not meaning.
   */
  import {
    Alert,
    Badge,
    Button,
    DescriptionList,
    EmptyState,
    Skeleton,
    Table,
    Tooltip,
  } from '@lostgradient/cinder';
  import Lock from '@lucide/svelte/icons/lock';

  import { getClient } from '../../lib/client.ts';
  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { formatDuration, formatRelativeTime } from '../../lib/format/index.ts';
  import {
    getPrincipalStore,
    isForbidden,
    scopeGate,
    scopeReason,
  } from '../../lib/scopes.svelte.ts';
  import {
    MalformedConformanceError,
    summarizeConformance,
    type ConformanceReport,
  } from './conformance-evidence.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';
  import { conformanceTargetsQuery, runConformanceMutation } from './workers-data.ts';

  interface ConformancePanelProps {
    /** Reference instant for relative times; defaults to render time. */
    readonly now?: number;
  }

  let { now = Date.now() }: ConformancePanelProps = $props();

  const NO_TARGETS_DESCRIPTION =
    'This server registers no worker commands to check. Register one with serve({ conformanceTargets }) to run conformance here.';

  const client = getClient();
  const principalStore = getPrincipalStore();
  const adminGate = $derived(scopeGate(principalStore, ['system:admin']));

  const targetsQuery = conformanceTargetsQuery(client);

  type RunState =
    | { readonly kind: 'running' }
    | { readonly kind: 'report'; readonly report: ConformanceReport }
    | { readonly kind: 'failed'; readonly error: unknown };

  // One entry per target, so running one never hides another's last report.
  let runs = $state<Readonly<Record<string, RunState>>>({});

  function setRun(target: string, state: RunState): void {
    runs = { ...runs, [target]: state };
  }

  const run = runConformanceMutation(client, {
    onReport: (target, report) => setRun(target, { kind: 'report', report }),
    onFailure: (target, error) => setRun(target, { kind: 'failed', error }),
  });

  function runTarget(target: string): void {
    setRun(target, { kind: 'running' });
    run.mutate(target);
  }

  $effect(() => {
    if (isForbidden(targetsQuery.error) && principalStore.hasScope('system:read')) {
      principalStore.denyScope('system:read');
    }
  });

  const targets = $derived(targetsQuery.data?.targets);
  const error = $derived(targetsQuery.error);
  // A failed refresh keeps the last targets on screen and says so.
  const staleRefresh = $derived(targets !== undefined && error !== null);
</script>

<section class="weft-conformance" aria-labelledby="conformance-heading">
  <h2 id="conformance-heading" class="weft-conformance__heading">Worker conformance</h2>
  <p class="weft-conformance__intro">
    A conformance run starts a worker command this server registered at startup and checks that it
    follows the worker protocol, inside a private sandbox server. It reports on that command, not on
    the workers connected to this fleet, and never touches them. Concurrent runs of one target share
    a single run.
  </p>

  {#if targetsQuery.isPending}
    <div role="status" aria-busy="true" aria-label="Loading conformance targets">
      <Skeleton height="6rem" />
    </div>
  {:else if error && targets === undefined && isForbidden(error)}
    <EmptyState
      kind="first-use"
      title="Conformance is locked"
      description={`${scopeReason('system:read')} to list conformance targets.`}
    >
      {#snippet icon()}
        <Lock size={24} aria-hidden="true" />
      {/snippet}
    </EmptyState>
  {:else if error && targets === undefined && error instanceof MalformedConformanceError}
    <EmptyState kind="first-use" title="Malformed server response" description={error.message} />
  {:else if error && targets === undefined}
    {@const treatment = faultTreatment(error)}
    <EmptyState
      kind="first-use"
      title={FAULT_TREATMENT_TITLE[treatment.kind]}
      description={treatment.message}
    />
  {:else if targets}
    {#if staleRefresh}
      <Alert variant="warning"
        >Refreshing the target list failed, so this is the list from the last successful read.</Alert
      >
    {/if}
    {#if targets.length === 0}
      <EmptyState
        kind="first-use"
        title="No conformance targets"
        description={NO_TARGETS_DESCRIPTION}
      />
    {:else}
      <ul class="weft-conformance__targets">
        {#each targets as target (target.name)}
          {@const state = runs[target.name]}
          <li class="weft-conformance__target" aria-label={`Conformance target ${target.name}`}>
            <div class="weft-conformance__target-header">
              <span class="weft-workers-mono">{target.name}</span>
              <span class="weft-conformance__timeout"
                >{formatDuration(target.timeoutMs)} allowed per wait</span
              >
              {#if adminGate.disabled}
                <Tooltip text={adminGate.title ?? ''}>
                  <Button variant="secondary" size="sm" disabled label="Run conformance" />
                </Tooltip>
              {:else}
                <Button
                  data-changes
                  variant="secondary"
                  size="sm"
                  label={state?.kind === 'report' ? 'Run again' : 'Run conformance'}
                  loading={state?.kind === 'running'}
                  disabled={state?.kind === 'running'}
                  onclick={() => runTarget(target.name)}
                />
              {/if}
            </div>
            {#if adminGate.disabled}
              <p class="weft-conformance__note">
                {scopeReason('system:admin')} to run a target, because a run starts a process on the server
                host.
              </p>
            {/if}

            {#if state?.kind === 'running'}
              <div
                role="status"
                aria-busy="true"
                aria-label={`Running conformance for ${target.name}`}
              >
                <Skeleton height="4rem" />
              </div>
            {:else if state?.kind === 'failed'}
              {#if isForbidden(state.error)}
                <EmptyState
                  kind="first-use"
                  title="Running conformance is locked"
                  description={`${scopeReason('system:admin')} to run a target.`}
                />
              {:else if state.error instanceof MalformedConformanceError}
                <EmptyState
                  kind="first-use"
                  title="Malformed server response"
                  description={state.error.message}
                />
              {:else if faultTreatment(state.error).kind === 'not-found'}
                <EmptyState
                  kind="first-use"
                  title="Target no longer registered"
                  description={`The server no longer registers a target named ${target.name}.`}
                />
              {:else}
                {@const treatment = faultTreatment(state.error)}
                <EmptyState
                  kind="first-use"
                  title={FAULT_TREATMENT_TITLE[treatment.kind]}
                  description={treatment.message}
                />
              {/if}
            {:else if state?.kind === 'report'}
              {@const summary = summarizeConformance(state.report)}
              <div class="weft-conformance__report">
                <div class="weft-conformance__verdict">
                  <Badge variant={summary.variant}>{summary.label}</Badge>
                  <span>{summary.passed} passed · {summary.failed} failed</span>
                </div>
                <DescriptionList
                  items={[
                    {
                      term: 'Run',
                      definition: `${exactTimestamp(state.report.completedAt)} (${formatRelativeTime(state.report.completedAt, now)}), took ${formatDuration(state.report.completedAt - state.report.startedAt)}`,
                    },
                    {
                      term: 'Protocol version',
                      definition: `${state.report.protocolVersion} (server supports ${state.report.supportedProtocolVersions.join(', ')})`,
                    },
                  ]}
                />
                <Table
                  caption={`Conformance checks for ${target.name}`}
                  class="weft-conformance__checks"
                >
                  <Table.Header>
                    <Table.Row>
                      <Table.HeaderCell>Check</Table.HeaderCell>
                      <Table.HeaderCell>Result</Table.HeaderCell>
                      <Table.HeaderCell>Message</Table.HeaderCell>
                    </Table.Row>
                  </Table.Header>
                  <Table.Body>
                    {#each state.report.checks as check (check.name)}
                      <Table.Row>
                        <Table.Cell><span class="weft-workers-mono">{check.name}</span></Table.Cell>
                        <Table.Cell>
                          <Badge variant={check.ok ? 'success' : 'danger'} size="sm"
                            >{check.ok ? 'Pass' : 'Fail'}</Badge
                          >
                        </Table.Cell>
                        <Table.Cell>{check.message}</Table.Cell>
                      </Table.Row>
                    {/each}
                  </Table.Body>
                </Table>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  {/if}
</section>

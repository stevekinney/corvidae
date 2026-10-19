<script lang="ts">
  /**
   * Worker session evidence from `weft.workers.diagnostics` (COR-124): the
   * server's session generation, connection instant, heartbeat timing, and
   * health for one worker id. Reads the canonical diagnostics instance, not
   * the fleet list row, so a superseded session shows its own generation.
   * Every state is spelled out in text; badges add color but never carry
   * meaning alone.
   */
  import { Alert, Badge, DescriptionList, EmptyState, Skeleton } from '@lostgradient/cinder';

  import { FAULT_TREATMENT_TITLE, faultTreatment } from '../../lib/faults.ts';
  import { formatDuration, formatRelativeTime } from '../../lib/format/index.ts';
  import { isForbidden, scopeReason } from '../../lib/scopes.svelte.ts';
  import { exactTimestamp } from './task-attempt-evidence.ts';
  import { describeSessionLifecycle } from './worker-session-lifecycle.ts';
  import {
    MalformedWorkerDiagnosticsError,
    type WorkerManifestDiagnostics,
  } from './worker-manifest-diagnostics.ts';
  import { HEARTBEAT_STALE_AFTER_MS, TRANSPORT_LABEL } from './worker-presentation.ts';

  interface WorkerSessionPanelProps {
    readonly diagnostics: WorkerManifestDiagnostics | null | undefined;
    readonly loading: boolean;
    readonly error: unknown;
    readonly now: number;
    /** Heartbeat age at or past which the session reads as stale. */
    readonly staleAfterMs?: number;
  }

  let {
    diagnostics,
    loading,
    error,
    now,
    staleAfterMs = HEARTBEAT_STALE_AFTER_MS,
  }: WorkerSessionPanelProps = $props();

  const HEALTH_LABEL = { active: 'Active', draining: 'Draining', drained: 'Drained' } as const;
  const HEALTH_VARIANT = { active: 'success', draining: 'warning', drained: 'neutral' } as const;

  const instance = $derived(diagnostics?.instance);
  const stale = $derived(instance !== undefined && instance.heartbeatAgeMs >= staleAfterMs);

  const lifecycle = $derived(instance ? describeSessionLifecycle(instance, now) : undefined);

  const sessionItems = $derived(
    instance && lifecycle
      ? [
          { term: 'Lifecycle', definition: lifecycle.label },
          { term: 'Registration', definition: lifecycle.registration },
          { term: 'Transport', definition: TRANSPORT_LABEL[instance.transport] },
          { term: 'Connection', definition: lifecycle.connection },
          { term: 'Session deadline', definition: lifecycle.deadline },
          { term: 'Authoritative queue', definition: instance.queue },
          { term: 'Session generation', definition: String(instance.sessionGeneration) },
          { term: 'Health', definition: HEALTH_LABEL[instance.health] },
          {
            term: 'Connected at',
            definition: `${exactTimestamp(instance.connectedAt)} (${formatRelativeTime(instance.connectedAt, now)})`,
          },
          { term: 'Last heartbeat', definition: exactTimestamp(instance.lastHeartbeatAt) },
          {
            term: 'Heartbeat age',
            definition: `${formatDuration(instance.heartbeatAgeMs)} · ${stale ? 'stale' : 'fresh'} (stale at ${formatDuration(staleAfterMs)})`,
          },
        ]
      : [],
  );
</script>

<section class="weft-workers-panel weft-worker-session" aria-labelledby="worker-session-heading">
  <div class="weft-workers-panel__header weft-worker-session__header">
    <h2 id="worker-session-heading">Session</h2>
    {#if instance && lifecycle}
      <Badge variant={lifecycle.variant}>{lifecycle.label}</Badge>
      <Badge variant={HEALTH_VARIANT[instance.health]}>{HEALTH_LABEL[instance.health]}</Badge>
      <Badge variant={stale ? 'danger' : 'success'}
        >{stale ? 'Heartbeat stale' : 'Heartbeat fresh'}</Badge
      >
    {/if}
  </div>

  <div class="weft-worker-session__body">
    {#if loading}
      <div role="status" aria-busy="true" aria-label="Loading worker session">
        <Skeleton height="6rem" />
      </div>
    {:else if error && isForbidden(error)}
      <EmptyState
        title="Session evidence is locked"
        description={`${scopeReason('system:read')} to read worker session diagnostics.`}
      />
    {:else if error instanceof MalformedWorkerDiagnosticsError}
      <EmptyState title="Malformed server response" description={error.message} />
    {:else if error}
      {@const treatment = faultTreatment(error)}
      <EmptyState title={FAULT_TREATMENT_TITLE[treatment.kind]} description={treatment.message} />
    {:else if diagnostics === null}
      <EmptyState
        title="Session closed"
        description="The server reports no registered session for this worker id: the worker has closed, or it was removed."
      />
    {:else if instance}
      {#if stale}
        <Alert variant="warning"
          >No heartbeat for {formatDuration(instance.heartbeatAgeMs)}. The session may be slow or
          about to be superseded. A proven resume keeps generation {instance.sessionGeneration}; a
          fresh or unproven registration reports a higher one.</Alert
        >
      {/if}
      <DescriptionList items={sessionItems} />
    {:else}
      <EmptyState
        title="Session evidence unavailable"
        description="Worker diagnostics have not been read for this worker yet."
      />
    {/if}
  </div>
</section>

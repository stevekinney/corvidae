<script lang="ts">
  /**
   * One workflow's manifest-to-registry verification (COR-162). Every status
   * is written out as text next to its badge color, so no state is conveyed
   * by color alone.
   */
  import { Badge, Table } from '@lostgradient/cinder';

  import {
    ACTIVITY_STATUS_LABELS,
    WORKFLOW_IDENTITY_REASON_LABELS,
    type ActivityVerificationStatus,
    type WorkflowVerification,
    type WorkflowVerificationStatus,
  } from './contract-verification.ts';

  interface WorkflowVerificationDetailProps {
    readonly verification: WorkflowVerification;
    /** Prefixes the table caption, for example with the worker identifier. */
    readonly captionPrefix?: string;
  }

  let { verification, captionPrefix = '' }: WorkflowVerificationDetailProps = $props();

  const WORKFLOW_STATUS: Readonly<
    Record<WorkflowVerificationStatus, { label: string; variant: 'success' | 'danger' }>
  > = {
    matched: { label: 'Matches registry', variant: 'success' },
    drift: { label: 'Drift detected', variant: 'danger' },
    extra: { label: 'Not in registry', variant: 'danger' },
  };

  const ACTIVITY_VARIANT: Readonly<
    Record<ActivityVerificationStatus, 'success' | 'danger' | 'warning'>
  > = {
    matched: 'success',
    missing: 'danger',
    extra: 'danger',
    unconfirmed: 'warning',
  };

  const status = $derived(WORKFLOW_STATUS[verification.status]);
  const hasUnconfirmed = $derived(
    verification.activities.some((activity) => activity.status === 'unconfirmed'),
  );
</script>

<div class="weft-workflow-verification">
  <div class="weft-workflow-verification__heading">
    <span class="weft-workers-mono weft-workflow-verification__name">{verification.workflow}</span>
    <Badge variant={status.variant}>{status.label}</Badge>
  </div>

  {#if verification.status === 'extra'}
    <p class="weft-workflow-verification__note">
      The registry has no active revision of this workflow, so the worker serves it without a
      registered contract.
    </p>
  {/if}

  {#if verification.identityDrift.length > 0}
    <ul class="weft-workflow-verification__drift" aria-label="Workflow identity drift">
      {#each verification.identityDrift as drift (drift.reason)}
        <li>
          <span>{WORKFLOW_IDENTITY_REASON_LABELS[drift.reason]}</span>
          <span class="weft-workers-mono">worker {drift.worker}</span>
          <span class="weft-workers-mono">registry {drift.registry}</span>
        </li>
      {/each}
    </ul>
  {/if}

  {#if verification.activities.length === 0}
    <p class="weft-workflow-verification__note">
      Neither the worker nor the registry declares activities.
    </p>
  {:else}
    <Table caption={`${captionPrefix}${verification.workflow} activity verification`} scrollable>
      <Table.Header>
        <Table.Row>
          <Table.HeaderCell>Activity</Table.HeaderCell>
          <Table.HeaderCell>Status</Table.HeaderCell>
          <Table.HeaderCell>Worker contract hash</Table.HeaderCell>
        </Table.Row>
      </Table.Header>
      <Table.Body>
        {#each verification.activities as activity (activity.name)}
          <Table.Row>
            <Table.Cell as="th" class="weft-workers-mono">{activity.name}</Table.Cell>
            <Table.Cell>
              <Badge variant={ACTIVITY_VARIANT[activity.status]}
                >{ACTIVITY_STATUS_LABELS[activity.status]}</Badge
              >
            </Table.Cell>
            <Table.Cell class="weft-workers-mono">{activity.workerContractHash ?? '—'}</Table.Cell>
          </Table.Row>
        {/each}
      </Table.Body>
    </Table>
  {/if}

  {#if hasUnconfirmed}
    <p class="weft-workflow-verification__note">
      The workflow contract hash differs, so the dashboard cannot tell which shared activity
      changed. Run <code>weft worker verify</code> to check each activity's contract hash.
    </p>
  {/if}
</div>

<style>
  .weft-workflow-verification {
    display: flex;
    flex-direction: column;
    gap: 8px;
    min-width: 0;
  }

  .weft-workflow-verification__heading {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
  }

  .weft-workflow-verification__name {
    font-weight: 600;
    overflow-wrap: anywhere;
  }

  .weft-workflow-verification__drift {
    margin: 0;
    padding-inline-start: 1.25rem;
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--cinder-text-sm);
  }

  .weft-workflow-verification__drift li {
    display: flex;
    flex-wrap: wrap;
    gap: 4px 10px;
    overflow-wrap: anywhere;
  }

  .weft-workflow-verification__note {
    margin: 0;
    font-size: var(--cinder-text-sm);
    color: var(--cinder-text-muted);
  }
</style>

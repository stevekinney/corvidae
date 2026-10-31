<script lang="ts">
  /**
   * Deployment versions and routing (COR-277): for each deployment, the routing
   * pointer (current and ramping build, traffic share, generation), every
   * retained immutable build with its lifecycle state, digests, references, and
   * connected workers, and the operator actions on them. The view decides
   * nothing about routing: it shows what the server reports and calls back for
   * each action, and every action is gated on `system:admin` with the reason
   * shown when it is not held.
   */
  import { Badge, Button, DescriptionList, EmptyState, Table, Tooltip } from '@lostgradient/cinder';

  import { formatRelativeTime, truncateId } from '../../lib/format/index.ts';
  import type { ScopeGate } from '../../lib/scopes.svelte.ts';
  import type { DeploymentOverview } from './deployments-data.ts';
  import {
    formatBasisPoints,
    moveDirection,
    removalBlockedReason,
    versionFleet,
    versionRole,
    versionStatePresentation,
  } from './deployments-presentation.ts';
  import type { WorkerSummary } from './worker-catalog-types.ts';
  import WorkflowBucketExplainer from './workflow-bucket-explainer.svelte';

  interface DeploymentVersionsViewProps {
    readonly overviews: readonly DeploymentOverview[];
    readonly workers: readonly WorkerSummary[];
    readonly adminGate: ScopeGate;
    readonly now: number;
    readonly onSetRouting: (deploymentName: string) => void;
    readonly onMove: (
      kind: 'promote' | 'rollback',
      deploymentName: string,
      buildId: string,
    ) => void;
    readonly onDrain: (deploymentName: string, buildId: string) => void;
    readonly onResume: (deploymentName: string, buildId: string) => void;
    readonly onRemove: (deploymentName: string, buildId: string) => void;
  }

  let {
    overviews,
    workers,
    adminGate,
    now,
    onSetRouting,
    onMove,
    onDrain,
    onResume,
    onRemove,
  }: DeploymentVersionsViewProps = $props();

  const ROLE_LABEL = { current: 'Current', ramping: 'Ramping', none: '' } as const;
</script>

{#if overviews.length === 0}
  <EmptyState
    title="No deployment versions"
    description="No worker has registered a deployment build with this server yet. Builds appear here once a worker with a deploymentName and buildId connects."
  />
{:else}
  <div class="weft-deployments">
    {#each overviews as overview, index (overview.deploymentName)}
      {@const routing = overview.routing}
      {@const visible = overview.versions.filter((version) => version.state !== 'removed')}
      {@const removed = overview.versions.length - visible.length}
      <section
        class="weft-workers-panel weft-deployment"
        aria-labelledby={`deployment-heading-${index}`}
      >
        <div class="weft-workers-panel__header weft-deployment__header">
          <h2 id={`deployment-heading-${index}`} class="weft-deployment__name">
            {overview.deploymentName}
          </h2>
          {#if adminGate.disabled}
            <Tooltip text={adminGate.title ?? ''}>
              <Button variant="secondary" size="sm" disabled label="Set routing" />
            </Tooltip>
          {:else}
            <Button
              variant="secondary"
              size="sm"
              label="Set routing"
              onclick={() => onSetRouting(overview.deploymentName)}
            />
          {/if}
        </div>

        <div class="weft-deployment__body">
          {#if routing === null}
            <p class="weft-deployment__note">
              No routing pointer yet. Until one is set, no build is chosen for unpinned traffic.
            </p>
          {:else}
            <DescriptionList
              items={[
                { term: 'Current build', definition: routing.currentBuildId },
                { term: 'Ramping build', definition: routing.rampingBuildId ?? 'None' },
                {
                  term: 'Traffic to the ramping build',
                  definition:
                    routing.rampingBuildId === undefined
                      ? 'Not applicable'
                      : `${formatBasisPoints(routing.rampBasisPoints)} (${routing.rampBasisPoints} of 10000 basis points)`,
                },
                { term: 'Rollout generation', definition: String(routing.generation) },
                { term: 'Updated', definition: formatRelativeTime(routing.updatedAt, now) },
              ]}
            />
          {/if}

          <WorkflowBucketExplainer
            deploymentName={overview.deploymentName}
            inputId={`bucket-workflow-${index}`}
            {routing}
            versions={overview.versions}
          />

          <Table
            caption={`Builds of ${overview.deploymentName}`}
            scrollable
            class="weft-deployment__versions"
          >
            <Table.Header>
              <Table.Row>
                <Table.HeaderCell>Build</Table.HeaderCell>
                <Table.HeaderCell>State</Table.HeaderCell>
                <Table.HeaderCell>Artifact digest</Table.HeaderCell>
                <Table.HeaderCell>Manifest digest</Table.HeaderCell>
                <Table.HeaderCell>References</Table.HeaderCell>
                <Table.HeaderCell>Workers</Table.HeaderCell>
                <Table.HeaderCell>Actions</Table.HeaderCell>
              </Table.Row>
            </Table.Header>
            <Table.Body>
              {#each visible as version (version.buildId)}
                {@const role = versionRole(routing, version.buildId)}
                {@const state = versionStatePresentation(version)}
                {@const fleet = versionFleet(workers, version.deploymentName, version.buildId)}
                {@const blocked = removalBlockedReason(version, routing, fleet)}
                <Table.Row>
                  <Table.Cell>
                    <span class="weft-workers-mono">{version.buildId}</span>
                    {#if role !== 'none'}
                      <Badge variant="neutral" size="sm">{ROLE_LABEL[role]}</Badge>
                    {/if}
                  </Table.Cell>
                  <Table.Cell
                    ><Badge variant={state.variant} size="sm">{state.label}</Badge></Table.Cell
                  >
                  <Table.Cell
                    ><span class="weft-workers-mono" title={version.artifactDigest}
                      >{truncateId(version.artifactDigest)}</span
                    ></Table.Cell
                  >
                  <Table.Cell
                    ><span class="weft-workers-mono" title={version.manifestDigest}
                      >{truncateId(version.manifestDigest)}</span
                    ></Table.Cell
                  >
                  <Table.Cell>
                    {version.executionReferences}
                    {version.executionReferences > 0 ? 'referenced · reachable' : 'unreferenced'}
                  </Table.Cell>
                  <Table.Cell>
                    {#if fleet.workers === 0}
                      None connected
                    {:else}
                      {fleet.workers}
                      {fleet.workers === 1 ? 'worker' : 'workers'} · {fleet.inFlight}/{fleet.concurrency}
                      in flight{fleet.draining + fleet.drained > 0
                        ? ` · ${fleet.draining} draining, ${fleet.drained} drained`
                        : ''}
                    {/if}
                  </Table.Cell>
                  <Table.Cell>
                    <div class="weft-deployment__actions">
                      {#if adminGate.disabled}
                        <Tooltip text={adminGate.title ?? ''}>
                          <Button variant="ghost" size="sm" disabled label="Drain" />
                        </Tooltip>
                      {:else}
                        {#if role !== 'current' && version.state === 'ready'}
                          {@const direction = moveDirection(routing, overview.versions, version)}
                          <Button
                            variant="ghost"
                            size="sm"
                            label={direction === 'rollback' ? 'Roll back to' : 'Promote'}
                            onclick={() =>
                              onMove(direction, version.deploymentName, version.buildId)}
                          />
                        {/if}
                        <Button
                          variant="ghost"
                          size="sm"
                          label="Drain"
                          onclick={() => onDrain(version.deploymentName, version.buildId)}
                        />
                        <Button
                          data-changes
                          variant="ghost"
                          size="sm"
                          label="Resume"
                          onclick={() => onResume(version.deploymentName, version.buildId)}
                        />
                        {#if blocked === undefined}
                          <Button
                            data-changes
                            variant="ghost"
                            size="sm"
                            label="Remove"
                            onclick={() => onRemove(version.deploymentName, version.buildId)}
                          />
                        {:else}
                          <Button variant="ghost" size="sm" disabled label="Remove" />
                        {/if}
                      {/if}
                    </div>
                    {#if blocked !== undefined}
                      <p class="weft-deployment__blocked">Cannot remove: {blocked}</p>
                    {/if}
                  </Table.Cell>
                </Table.Row>
              {/each}
            </Table.Body>
          </Table>
          {#if removed > 0}
            <p class="weft-deployment__note">
              {removed} removed {removed === 1 ? 'build is' : 'builds are'} retained by the server and
              not listed.
            </p>
          {/if}
        </div>
      </section>
    {/each}
  </div>
{/if}

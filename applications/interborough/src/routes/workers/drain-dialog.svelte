<script lang="ts">
  /**
   * Drain-with-reason dialog (plan §9.4 T5.2: "drain (with reason) / resume
   * per worker and per deployment"). Draining is reversible (Resume undoes
   * it immediately, no confirmation — see `worker-detail-view.svelte`), so it
   * asks without a typed confirmation, the way every reversible confirmation
   * in this app does (`agents/agent-settings.svelte`'s disable). It is still
   * Cinder's `ConfirmDialog`, so the sheet layout on a phone, the focus on
   * Cancel and the busy state are inherited: the description says what a
   * drain does, and the options hold the one thing that changes what it
   * does, the optional reason, and the warning for a build that routing
   * names.
   */
  import { Callout, ConfirmDialog, Textarea } from '@lostgradient/cinder';
  import { TriangleAlert } from '@lucide/svelte';

  export type DrainTarget =
    | { readonly kind: 'worker'; readonly id: string }
    | { readonly kind: 'deployment'; readonly name: string }
    | { readonly kind: 'build'; readonly deploymentName: string; readonly buildId: string };

  interface DrainDialogProps {
    readonly open: boolean;
    readonly target: DrainTarget;
    /** For a build target: whether routing names the build as its current or ramping one. */
    readonly routingRole?: 'current' | 'ramping' | 'none' | undefined;
    readonly submitting: boolean;
    readonly onDrain: (reason: string | undefined) => void;
    readonly onCancel: () => void;
  }

  let {
    open = $bindable(),
    target,
    routingRole = 'none',
    submitting,
    onDrain,
    onCancel,
  }: DrainDialogProps = $props();

  let reason = $state('');

  $effect(() => {
    if (open) reason = '';
  });

  const targetLabel = $derived(
    target.kind === 'worker'
      ? target.id
      : target.kind === 'deployment'
        ? target.name
        : `${target.deploymentName}/${target.buildId}`,
  );
  const title = $derived(
    target.kind === 'worker'
      ? 'Drain worker'
      : target.kind === 'deployment'
        ? 'Drain deployment'
        : 'Drain build',
  );

  function handleDrain(): void {
    const trimmed = reason.trim();
    onDrain(trimmed.length > 0 ? trimmed : undefined);
  }
</script>

{#snippet description()}
  Draining <code>{targetLabel}</code> stops new task assignment while in-flight work finishes. Resume
  clears the drain marker at any time.
{/snippet}

{#snippet options()}
  {#if target.kind === 'build' && routingRole !== 'none'}
    <Callout variant="warning" semantic="note" title={`This is the ${routingRole} build`}>
      {#snippet icon()}
        <TriangleAlert aria-hidden="true" size={17} />
      {/snippet}
      {#if routingRole === 'current'}
        Routing sends new traffic to this build, except the share it ramps to another build. While
        it drains, the server refuses new starts of workflows that carry a worker versioning policy
        that land on it, until you resume it or route traffic to another build.
      {:else}
        Routing sends only the ramp share of new traffic to this build. While it drains, the server
        refuses new starts of workflows that carry a worker versioning policy and land in that
        share; starts outside the share are not affected. Resume it or end the ramp to stop the
        refusals.
      {/if}
    </Callout>
  {/if}
  <Textarea
    id="drain-reason"
    label="Reason"
    description="Optional — shown to operators viewing this worker while it drains."
    bind:value={reason}
    rows={3}
    placeholder="e.g. rolling deploy #4791"
  />
{/snippet}

<ConfirmDialog
  bind:open
  {title}
  {description}
  {options}
  confirmLabel={title}
  busy={submitting}
  closeOnConfirm={false}
  onConfirm={handleDrain}
  {onCancel}
/>

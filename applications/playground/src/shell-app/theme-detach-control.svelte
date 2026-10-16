<script lang="ts">
  /*
   * "Replace with literal" (COR-488), the one detach every editor shares. The alias or recipe
   * is never severed by pressing the button: it computes a proposal, and the revision-bound
   * impact list shows every value that would change in all six contexts. The author applies
   * that exact result as one transaction (one Undo restores the link) or cancels.
   */
  import { Button } from '@lostgradient/cinder';

  import type { CatalogueRow } from './theme-builder-catalogue.ts';
  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import type { OverrideScope } from './theme-draft-types.ts';
  import ThemeProposalFlow from './theme-proposal-flow.svelte';
  import { proposeDetach, type Proposal } from './theme-reference-edits.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    controller: ThemeBuilderController;
    workbench: ThemeWorkbenchState;
    row: CatalogueRow;
    scope: OverrideScope | null;
    label?: string;
    disabled?: boolean;
  };
  let {
    controller,
    workbench,
    row,
    scope,
    label = 'Replace with literal',
    disabled = false,
  }: Props = $props();

  let proposal = $state.raw<Proposal | null>(null);

  const title = $derived(`Replace ${row.path} with a literal`);

  function propose(): void {
    const draft = controller.draft;
    if (draft === null) return;
    proposal = proposeDetach(draft, row, workbench.context, scope);
    if (!proposal.ok) controller.announcement = proposal.message;
  }
</script>

<div class="detach" data-testid="detach-control">
  <Button {label} variant="secondary" {disabled} onclick={propose} />
  <ThemeProposalFlow
    {controller}
    {proposal}
    {title}
    idBase={`theme-builder-detach-${row.path.replaceAll('.', '-')}`}
    onapplied={() => (proposal = null)}
    oncancel={() => {
      proposal = null;
      controller.announcement = 'Cancelled. Nothing changed.';
    }}
  />
</div>

<style>
  .detach {
    display: grid;
    gap: 8px;
    justify-items: start;
    min-width: 0;
  }
</style>

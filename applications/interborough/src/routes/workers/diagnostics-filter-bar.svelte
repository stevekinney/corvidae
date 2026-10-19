<script lang="ts">
  /**
   * Provenance filters for the Diagnostics tab: deployment name, build ID,
   * artifact digest, worker ID, and workflow revision. Typing edits a draft;
   * Apply sends the draft to the server (`weft.tasks.diagnostics` matches it
   * against the identity recorded on each task's attempts), so no request is
   * made per keystroke and nothing is joined against live fleet state.
   */
  import { Button, Input } from '@lostgradient/cinder';

  import { hasProvenanceFilters, PROVENANCE_FILTER_LABEL } from './provenance-filters.ts';
  import {
    PROVENANCE_FILTER_FIELDS,
    type ProvenanceFilterField,
    type TaskProvenanceFilters,
  } from './worker-catalog-types.ts';

  interface DiagnosticsFilterBarProps {
    readonly filters: TaskProvenanceFilters;
    readonly onApply: (filters: TaskProvenanceFilters) => void;
    readonly onClear: () => void;
  }

  let { filters, onApply, onClear }: DiagnosticsFilterBarProps = $props();

  function draftFrom(applied: TaskProvenanceFilters): Record<ProvenanceFilterField, string> {
    return {
      deploymentName: applied.deploymentName ?? '',
      buildId: applied.buildId ?? '',
      artifactDigest: applied.artifactDigest ?? '',
      workerId: applied.workerId ?? '',
      workflowRevision: applied.workflowRevision ?? '',
    };
  }

  // The draft starts empty and re-syncs to the applied filters (URL, back, forward).
  let draft = $state<Record<ProvenanceFilterField, string>>(draftFrom({}));
  $effect(() => {
    draft = draftFrom(filters);
  });

  function apply(event: SubmitEvent): void {
    event.preventDefault();
    const next: Partial<Record<ProvenanceFilterField, string>> = {};
    for (const field of PROVENANCE_FILTER_FIELDS) {
      const value = draft[field].trim();
      if (value) next[field] = value;
    }
    onApply(next);
  }
</script>

<form
  class="weft-diagnostics-filters"
  aria-label="Filter diagnostics by worker provenance"
  onsubmit={apply}
>
  {#each PROVENANCE_FILTER_FIELDS as field (field)}
    <Input
      id={`diagnostics-filter-${field}`}
      label={PROVENANCE_FILTER_LABEL[field]}
      bind:value={draft[field]}
      class="weft-workers-mono"
    />
  {/each}
  <div class="weft-diagnostics-filters__actions">
    <Button type="submit" variant="primary" size="sm" label="Apply filters" />
    <Button
      variant="secondary"
      size="sm"
      label="Clear filters"
      disabled={!hasProvenanceFilters(filters)}
      onclick={onClear}
    />
  </div>
</form>

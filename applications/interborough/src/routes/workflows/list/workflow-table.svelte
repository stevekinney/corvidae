<script lang="ts">
  /**
   * Workflow list table (plan §9.2 T2.1). Compositional Cinder `Table`
   * family, not `DataTable`: `DataTable` interpolates `row[column.key]` as
   * plain text (verified against `data-table.svelte` — no snippet/cell-
   * renderer support) and its own README says "Avoid When: composing a
   * bespoke table layout with custom cell markup — use the compositional
   * Table family directly." This row needs a status badge, a copyable
   * truncated id, tag chips, and (scaffolded) selection checkboxes — real
   * cell content `DataTable` cannot render, so this uses `Table` +
   * `Table.Row`/`Table.Cell` directly, per that guidance.
   *
   * Column widths mirror the actual "Workflow list" screen markup in
   * `design/Weft UI.dc.html` (`grid-template-columns:36px 116px 220px
   * 150px 1fr 92px 92px 70px`) — NOT the `110px 1fr 150px…` string in
   * `design/README.md`, which is that file's own paraphrase but is actually
   * the *Schedule* list's grid (`Weft UI.dc.html` line ~931); the
   * `.dc.html` markup is PROJECT-BRIEF's pixel-fidelity source of truth.
   * `<colgroup>` + `table-layout:fixed` reproduces the same fixed/flexible
   * column split for a real `<table>` (Tags is the flexible column). The
   * table fits its container at every width (Cinder's `fit`, row 16c): a
   * column whose content never wraps (a status badge with its icon, a
   * shortened ID with its copy button, a time) is a fixed rem width that holds
   * it, so the ID is never cut a second time; Revision wraps a shortened
   * revision onto two lines at most, and its comparison badge ends with an
   * ellipsis beside its own tooltip; Type and Tags share what is left, and each ends a long value with
   * an ellipsis.
   *
   * No column is sortable: weft's list order is server-fixed
   * (`createdAt desc, id asc` — plan Ground Truth), so there is no sort
   * call to wire a clickable header to; making a header LOOK sortable with
   * nothing behind it would be worse than no affordance.
   *
   * ## Revision column (WFT-117)
   *
   * Shows each row's own persisted `WorkflowSummary.revision` — never
   * `undefined` collapsed to a blank cell, always an explicit "Unpinned"
   * text badge for a pre-revision-pinning (legacy) record, so a missing
   * value never reads as a loading glitch. When the parent supplies
   * `revisionComparison` (COR-15), each pinned row also carries an
   * active-versus-bound badge ("Active" / "Differs from active"). The table
   * stays presentational: the parent (`workflow-list.svelte`) owns the
   * fetching — one `weft.workflows.active.get` per DISTINCT workflow type
   * on the page, via `createActiveRevisionComparisons` — so this component
   * still needs no query client and renders standalone.
   */
  import { Copy } from '@lucide/svelte';
  import { Badge, CopyButton, Table, Tooltip } from '@lostgradient/cinder';
  import type { WorkflowSummary } from '@lostgradient/weft';

  import { formatRelativeTime, truncateId } from '../../../lib/format/index.ts';
  import { router, workflowDetailPath, workflowRunPath } from '../../../lib/router.svelte.ts';
  import type { RevisionActiveComparison } from '../../../lib/workflow-revision.ts';
  import type { WorkflowFileRun } from '../../../lib/workflow-files.ts';
  import RevisionComparisonBadge from '../revision-comparison-badge.svelte';
  import { STARTED_BY_LABELS } from '../runs/started-by.ts';
  import { workflowStatusBadge } from './workflow-status-badge.ts';
  import WorkflowStatusIcon from './workflow-status-icon.svelte';

  interface WorkflowTableProps {
    rows: readonly WorkflowSummary[];
    /**
     * Scaffold-only bulk selection (plan §9.2: "bulk-select checkboxes …
     * SCAFFOLD only — count + disabled actions"). The checkboxes themselves
     * are fully functional (selecting rows is harmless, reversible local UI
     * state); it is the resulting bulk ACTION buttons in
     * `bulk-selection-bar.svelte` that render disabled-with-reason — the
     * server's dry-run/confirmation-token bulk flow is Phase 8, not this
     * track's. `undefined` hides the selection column entirely.
     */
    selectedIds?: Set<string>;
    onSelectionChange?: (next: Set<string>) => void;
    /** Ids that arrived live since the page was last fetched, for a brief highlight (plan §10.5: "new rows highlight briefly"). */
    recentlyChangedIds?: ReadonlySet<string>;
    /** How a row's persisted revision compares to its type's active revision (COR-15). Omitted: no comparison badge is shown. */
    revisionComparison?: (type: string, revision: string | undefined) => RevisionActiveComparison;
    workflowOrigins?: ReadonlyMap<
      string,
      Extract<NonNullable<WorkflowFileRun['origin']>, { kind: 'agent-run' }>
    >;
  }

  let {
    rows,
    selectedIds,
    onSelectionChange,
    recentlyChangedIds,
    revisionComparison,
    workflowOrigins,
  }: WorkflowTableProps = $props();

  const selectionEnabled = $derived(selectedIds !== undefined);
  const allSelected = $derived(
    selectionEnabled && rows.length > 0 && rows.every((row) => selectedIds?.has(row.id)),
  );
  const someSelected = $derived(
    selectionEnabled && !allSelected && rows.some((row) => selectedIds?.has(row.id)),
  );

  function toggleAll(next: boolean): void {
    onSelectionChange?.(next ? new Set(rows.map((row) => row.id)) : new Set());
  }

  function toggleRow(id: string, next: boolean): void {
    if (!selectedIds) return;
    const nextSet = new Set(selectedIds);
    if (next) nextSet.add(id);
    else nextSet.delete(id);
    onSelectionChange?.(nextSet);
  }

  /**
   * SPA-intercepted navigation for the id link, mirroring the shell's own
   * `router.href()` + guarded `preventDefault()` convention
   * (`src/app/shell/sidebar.svelte`'s `onNavClick`) so modifier-clicks
   * (open in new tab, etc.) keep working. The id link is the row's whole
   * navigation affordance — a `<tr onclick>` was considered and rejected:
   * it would also fire when the click originates from the row's own
   * selection checkbox or the copy button, re-navigating away from a
   * selection/copy action the user did not ask to leave the page for.
   */
  function onIdLinkClick(event: MouseEvent, workflowType: string, workflowId: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(workflowRunPath(workflowType, workflowId));
  }
</script>

<Table caption="Workflows" selectable={selectionEnabled} fit class="weft-workflows-table">
  <colgroup>
    {#if selectionEnabled}<col style="width: 36px" />{/if}
    <col style="width: 7rem" />
    <col style="width: 10.25rem" />
    <col />
    <col style="width: 5.5rem" />
    <col />
    <col style="width: 4.75rem" />
    <col style="width: 4.75rem" />
  </colgroup>
  <Table.Header {allSelected} {someSelected} onSelectAll={toggleAll}>
    <Table.Row>
      <Table.HeaderCell>Status</Table.HeaderCell>
      <Table.HeaderCell>Workflow ID</Table.HeaderCell>
      <Table.HeaderCell>Type</Table.HeaderCell>
      <Table.HeaderCell>Revision</Table.HeaderCell>
      <Table.HeaderCell>Tags</Table.HeaderCell>
      <Table.HeaderCell align="right">Created</Table.HeaderCell>
      <Table.HeaderCell align="right">Updated</Table.HeaderCell>
    </Table.Row>
  </Table.Header>
  <Table.Body>
    {#each rows as row (row.id)}
      {@const badge = workflowStatusBadge(row.status)}
      {@const selected = selectedIds?.has(row.id) ?? false}
      {@const workflowOrigin = workflowOrigins?.get(row.id)}
      <Table.Row
        {...recentlyChangedIds?.has(row.id) ? { class: 'weft-workflows-table__row--recent' } : {}}
        {...selectionEnabled
          ? {
              selected,
              selectionLabel: `Select workflow ${truncateId(row.id)}`,
              onSelectedChange: (next: boolean) => toggleRow(row.id, next),
            }
          : {}}
      >
        <Table.Cell>
          <Badge variant={badge.tone}>
            <WorkflowStatusIcon icon={badge.icon} />
            {badge.label}
          </Badge>
        </Table.Cell>
        <Table.Cell as="th">
          <span class="weft-workflows-table__id-cell">
            <span class="weft-workflows-table__id-line">
              <Tooltip text={row.id} placement="top">
                <a
                  class="weft-workflows-table__id-link"
                  href={router.href(workflowRunPath(row.type, row.id))}
                  onclick={(event) => onIdLinkClick(event, row.type, row.id)}
                >
                  <code>{truncateId(row.id)}</code>
                </a>
              </Tooltip>
              <CopyButton value={row.id} iconOnly label={`Copy workflow ID ${truncateId(row.id)}`}>
                <Copy aria-hidden="true" size={13} />
              </CopyButton>
            </span>
            {#if workflowOrigin !== undefined}
              <span class="weft-workflows-table__origin">
                <span>
                  <span class="weft-workflows-table__origin-label"
                    >{STARTED_BY_LABELS['agent-run']}</span
                  >
                  · {workflowOrigin.agentId}
                </span>
                <a href={router.href(workflowDetailPath(workflowOrigin.runId))}>Calling run</a>
              </span>
            {/if}
          </span>
        </Table.Cell>
        <Table.Cell truncate>{row.type}</Table.Cell>
        <Table.Cell>
          {#if row.revision !== undefined}
            <span class="weft-workflows-table__revision-cell">
              <Tooltip text={`Revision (exact executable artifact): ${row.revision}`}>
                <code class="weft-workflows-table__revision">{truncateId(row.revision)}</code>
              </Tooltip>
              {#if revisionComparison}
                <RevisionComparisonBadge comparison={revisionComparison(row.type, row.revision)} />
              {/if}
            </span>
          {:else}
            <Badge variant="neutral" size="xs">Unpinned</Badge>
          {/if}
        </Table.Cell>
        <Table.Cell>
          {#if row.tags && row.tags.filter((tag) => tag !== 'origin:agent-run').length > 0}
            <span class="weft-workflows-table__tags">
              {#each row.tags.filter((tag) => tag !== 'origin:agent-run') as tag (tag)}
                <Badge variant="neutral" size="xs" truncate>{tag}</Badge>
              {/each}
            </span>
          {/if}
        </Table.Cell>
        <Table.Cell align="right">
          <span class="weft-workflows-table__time" title={new Date(row.createdAt).toISOString()}>
            {formatRelativeTime(row.createdAt)}
          </span>
        </Table.Cell>
        <Table.Cell align="right">
          <span class="weft-workflows-table__time" title={new Date(row.updatedAt).toISOString()}>
            {formatRelativeTime(row.updatedAt)}
          </span>
        </Table.Cell>
      </Table.Row>
    {/each}
  </Table.Body>
</Table>

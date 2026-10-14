<script lang="ts">
  /*
   * Compact, Standard and Comfortable for one scale (COR-489, R5). Choosing a preset (or a custom
   * multiplier from 0 to 4) only computes a proposal. The proposal shows the scope it writes
   * to, every proposed value beside the base value, the aliases and recipes that follow, the
   * explicit overrides it would replace (those rows start unselected), locked tokens (they
   * cannot be selected), and the aliases and recipes it skips. Apply is one undoable
   * transaction and is refused once the base, draft or context has moved; Cancel changes
   * nothing. Applying values that are already there changes nothing and adds no history entry.
   */
  import { Button, Checkbox, Input, Select } from '@lostgradient/cinder';

  import type { ThemeBuilderController } from './theme-builder-controller.svelte.ts';
  import {
    activePreset,
    applyProposal,
    buildProposal,
    parseMultiplier,
    proposalIsStale,
    SCALE_PRESETS,
    selectableSelection,
    type Proposal,
    type ProposalRow,
  } from './theme-scale-presets.ts';
  import { overrideScopeFor, scopeOptions, type EditScope } from './theme-token-edit.ts';
  import type { ThemeWorkbenchState } from './theme-workbench-state.svelte.ts';

  type Props = {
    controller: ThemeBuilderController;
    workbench: ThemeWorkbenchState;
    scale: string;
    label: string;
  };
  let { controller, workbench, scale, label }: Props = $props();

  let scopeChoice = $state<EditScope>('shared');
  let custom = $state('');
  let customError = $state<string | undefined>(undefined);
  let proposal = $state.raw<Proposal | null>(null);
  let selected = $state.raw<readonly string[]>([]);
  let result = $state('');

  const idBase = $derived(`theme-builder-presets-${scale}`);
  const draft = $derived(controller.draft);
  const envelope = $derived(draft?.envelope ?? null);
  const options = $derived(scopeOptions(workbench.context));
  const scope = $derived(overrideScopeFor(scopeChoice, workbench.context));
  const scopeText = $derived(options.find((option) => option.value === scopeChoice)?.label ?? '');
  const active = $derived(
    envelope === null || scope === null
      ? null
      : activePreset(envelope, workbench.context, scope, scale),
  );
  const activeLabel = $derived(SCALE_PRESETS.find((preset) => preset.id === active)?.label);
  const stale = $derived(
    proposal !== null &&
      envelope !== null &&
      draft !== null &&
      proposalIsStale(proposal, envelope, draft.revision, workbench.context, scope),
  );

  $effect(() => {
    if (!options.find((option) => option.value === scopeChoice)?.disabled) return;
    scopeChoice = 'shared';
  });

  function propose(factor: number): void {
    if (envelope === null || draft === null || scope === null) return;
    result = '';
    proposal = buildProposal({
      envelope,
      draftRevision: draft.revision,
      context: workbench.context,
      scope,
      scale,
      factor,
    });
    selected = proposal.rows.filter((row) => row.selectedByDefault).map((row) => row.path);
    controller.announcement = `${label} proposal for ${factor}: ${proposal.rows.length} values, review before applying.`;
  }

  function proposeCustom(): void {
    const parsed = parseMultiplier(custom);
    customError = parsed.ok ? undefined : parsed.message;
    if (parsed.ok) propose(parsed.factor);
  }

  function toggle(path: string, on: boolean): void {
    selected = on ? [...new Set([...selected, path])] : selected.filter((entry) => entry !== path);
  }

  function selectAll(on: boolean): void {
    selected =
      on && proposal !== null
        ? proposal.rows.filter((row) => row.selectable).map((row) => row.path)
        : [];
  }

  function cancel(): void {
    proposal = null;
    result = '';
    controller.announcement = `${label} proposal cancelled.`;
  }

  async function apply(): Promise<void> {
    const current = proposal;
    if (current === null || envelope === null || stale) return;
    const name =
      current.presetId === null
        ? `${current.factor}×`
        : SCALE_PRESETS.find((p) => p.id === current.presetId)!.label;
    const outcome = await controller.commit({
      kind: 'edit',
      label: `Apply ${name} ${label.toLowerCase()}`,
      state: applyProposal(envelope, current, selected),
    });
    proposal = null;
    result = !outcome.ok
      ? `Could not apply: ${outcome.message}`
      : outcome.changed
        ? `Applied ${name} ${label.toLowerCase()} to ${selectableSelection(current, selected).length} tokens.`
        : `No change: ${name} ${label.toLowerCase()} is already applied in this scope.`;
    controller.announcement = result;
  }

  const describe = (row: ProposalRow): string =>
    row.status === 'locked'
      ? 'Locked'
      : row.status === 'overridden'
        ? 'Has an override; select to replace it'
        : row.status === 'applied'
          ? 'Already applied'
          : 'No override';
  const shown = (row: ProposalRow['base']): string => `${row.value}${row.unit}`;
</script>

<section class="presets" aria-labelledby={`${idBase}-heading`} data-testid={`presets-${scale}`}>
  <h3 id={`${idBase}-heading`}>{label} presets</h3>
  <p class="muted" data-testid={`presets-${scale}-active`}>
    {activeLabel === undefined ? 'No named preset is active.' : `Active: ${activeLabel}.`}
  </p>

  <Select
    id={`${idBase}-scope`}
    label={`${label} preset scope`}
    {options}
    value={scopeChoice}
    onchange={(event) => {
      scopeChoice = event.currentTarget.value as EditScope;
      proposal = null;
    }}
  />

  <div class="buttons" role="group" aria-label={`${label} presets`}>
    {#each SCALE_PRESETS as preset (preset.id)}
      <Button
        label={`${preset.label} (${preset.factor})`}
        variant="secondary"
        disabled={scope === null}
        onclick={() => propose(preset.factor)}
      />
    {/each}
  </div>
  <div class="custom">
    <Input
      id={`${idBase}-custom`}
      label={`${label} custom multiplier`}
      description="A finite number from 0 to 4."
      inputmode="decimal"
      autocomplete="off"
      value={custom}
      {...customError === undefined ? {} : { error: customError }}
      onValueChange={(next) => {
        custom = next;
        customError = undefined;
      }}
    />
    <Button label="Preview multiplier" variant="secondary" onclick={proposeCustom} />
  </div>

  {#if result !== ''}
    <p class="result" role="status" data-testid={`presets-${scale}-result`}>{result}</p>
  {/if}

  {#if proposal !== null}
    {@const current = proposal}
    <div
      class="proposal"
      role="region"
      aria-label={`${label} proposal`}
      data-testid={`proposal-${scale}`}
    >
      <p>
        <strong
          >{SCALE_PRESETS.find((p) => p.id === current.presetId)?.label ?? 'Custom'} ×{current.factor}</strong
        >
        writes to <strong>{scopeText}</strong>. Nothing changes until you apply.
      </p>
      {#if stale}
        <p class="stale" role="alert" data-testid={`proposal-${scale}-stale`}>
          This proposal is out of date because the theme, base or context changed. Preview it again
          to apply.
        </p>
      {/if}
      <div class="buttons" role="group" aria-label={`${label} selection`}>
        <Button
          label="Select all rows"
          variant="ghost"
          size="sm"
          disabled={stale}
          onclick={() => selectAll(true)}
        />
        <Button
          label="Clear selection"
          variant="ghost"
          size="sm"
          disabled={stale}
          onclick={() => selectAll(false)}
        />
      </div>
      <table>
        <caption class="sr-only">Proposed {label.toLowerCase()} values</caption>
        <thead>
          <tr>
            <th scope="col">Include</th>
            <th scope="col">Token</th>
            <th scope="col">Base</th>
            <th scope="col">Proposed</th>
            <th scope="col">Status</th>
          </tr>
        </thead>
        <tbody>
          {#each current.rows as row (row.path)}
            <tr data-path={row.path} data-status={row.status}>
              <td>
                <Checkbox
                  id={`${idBase}-row-${row.path.replaceAll('.', '-')}`}
                  label={`Include ${row.name} (${row.path})`}
                  checked={row.selectable && selected.includes(row.path)}
                  disabled={!row.selectable || stale}
                  onValueChange={(next) => toggle(row.path, next)}
                />
              </td>
              <td><code>{row.path}</code></td>
              <td>{shown(row.base)}</td>
              <td><strong>{shown(row.proposed)}</strong></td>
              <td>
                {describe(row)}{row.existing === undefined
                  ? ''
                  : ` (${JSON.stringify(row.existing)})`}
                {#if row.laterLayers.length > 0}
                  . Still overridden by {row.laterLayers.join(', ')}.
                {/if}
              </td>
            </tr>
          {/each}
        </tbody>
      </table>
      <p class="muted" data-testid={`proposal-${scale}-dependents`}>
        Follow these values: {current.dependents.aliases.length} aliases and
        {current.dependents.recipes.length} recipes
        {#if current.dependents.aliases.length + current.dependents.recipes.length > 0}
          ({[...current.dependents.aliases, ...current.dependents.recipes]
            .slice(0, 8)
            .join(', ')}{current.dependents.aliases.length + current.dependents.recipes.length > 8
            ? ', …'
            : ''}).
        {/if}
        They are not changed.
      </p>
      {#if current.skipped.length > 0}
        <p class="muted" data-testid={`proposal-${scale}-skipped`}>
          Skipped: {current.skipped.map((entry) => `${entry.path} (${entry.kind})`).join(', ')}.
        </p>
      {/if}
      <div class="buttons">
        <Button
          label="Apply proposal"
          variant="primary"
          disabled={stale || selectableSelection(current, selected).length === 0}
          onclick={() => void apply()}
        />
        <Button label="Cancel" variant="secondary" onclick={cancel} />
      </div>
    </div>
  {/if}
</section>

<style>
  .presets,
  .proposal {
    display: grid;
    gap: 8px;
    min-width: 0;
  }
  h3 {
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: var(--cinder-font-semibold);
  }
  p {
    margin: 0;
  }
  .muted {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
  .buttons,
  .custom {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 8px;
  }
  .proposal {
    padding: 8px;
    border: 1px solid var(--cinder-border-muted);
    border-radius: var(--cinder-radius-md);
    overflow-x: auto;
  }
  table {
    border-collapse: collapse;
    font-size: var(--cinder-text-sm);
  }
  th,
  td {
    padding: 2px 6px;
    text-align: start;
    vertical-align: top;
  }
  code {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
  .sr-only {
    position: absolute;
    width: 1px;
    height: 1px;
    margin: -1px;
    padding: 0;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
</style>

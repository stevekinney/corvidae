<script lang="ts">
  /**
   * One list of steps in the builder, and the steps in it, at any depth: the workflow's own steps
   * (each a bordered numbered card), and inside a card the steps of a case, an otherwise path, a list
   * of side-by-side steps or a repeat (each a flat row under a heading, indented one step by a single
   * leading rule, so no box ever sits inside a box). Every list reorders with Cinder's
   * `SortableList` in its move-button mode, which hides the buttons at the ends, announces a move and
   * keeps focus on the pressed button, and every list adds a step through one menu. A row's key is
   * the identity `StepKeys` gives it, so a move carries a step's open form with it.
   */
  import { Button, Input, NumberInput, SortableList } from '@lostgradient/cinder';
  import { Plus, Trash2 } from '@lucide/svelte';
  import type { Snippet } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import {
    bodyListAddress,
    bodyWhere,
    branchListAddress,
    branchWhere,
    caseListAddress,
    caseWhere,
    otherwiseListAddress,
    otherwiseWhere,
    stepAddress,
    stepFieldId,
    stepWhere,
  } from './workflow-builder-addresses.ts';
  import { useBuilderHost } from './workflow-builder-host.ts';
  import {
    addBranch,
    addCase,
    addOtherwise,
    moveStep,
    removeBranch,
    removeCase,
    removeOtherwise,
    removeStep,
    setBranchName,
    setCaseValue,
    setStepConcurrency,
    setStepField,
    setStepTitle,
    type BuilderStep,
    type ListPath,
  } from './workflow-builder-model.ts';
  import WorkflowAddStepMenu from './workflow-add-step-menu.svelte';
  import WorkflowSlotNameField from './workflow-slot-name-field.svelte';
  import WorkflowStepFields from './workflow-step-fields.svelte';

  interface Props {
    /** The workflow's own steps. */
    steps: readonly BuilderStep[];
    /** Where they are in the file: `['steps']`. */
    list: ListPath;
    /** The list's address, `''` for the workflow's own, which makes the ids of its steps. */
    address: string;
  }

  let { steps, list, address }: Props = $props();

  const host = useBuilderHost();
  const copy = WORKFLOW_COPY.builder;
  const flow = copy.controlFlow;

  /** One step of a list, with the key that travels with it and where it is. */
  interface Row {
    readonly step: BuilderStep;
    readonly key: string;
    /** The list it is in, and how deep that list is: `0` for the workflow's own, whose steps are cards. */
    readonly list: ListPath;
    readonly depth: number;
    readonly index: number;
    readonly position: number;
    readonly address: string;
    readonly where: string;
  }

  /**
   * The rows of a list, each with its key. The list a step holds is drawn by the same snippet, so
   * a list is described by its arguments, and this is read where the list is drawn.
   */
  function rowsOf(
    items: readonly BuilderStep[],
    where: ListPath,
    listAddress: string,
    listWhere: string | undefined,
    depth: number,
  ): Row[] {
    // Reads the version, so a move or a removal draws the keys it made.
    void host.keys.version;
    const keys = host.keys.keysOf(where, items.length);
    return items.map((step, index) => ({
      step,
      key: keys[index] ?? String(index),
      list: where,
      depth,
      index,
      position: index + 1,
      address: stepAddress(listAddress, index + 1),
      where: stepWhere(listWhere, index + 1),
    }));
  }

  /** The step's path in the file, as keys and indices. */
  function pathOf(row: Row): (string | number)[] {
    return [...row.list, row.index];
  }

  /** Moves the step at `change.fromIndex` of `where` to `change.toIndex`, one place at a time, and its key with it. */
  function reorder(where: ListPath, change: { fromIndex: number; toIndex: number }): void {
    const offset = change.toIndex > change.fromIndex ? 1 : -1;
    let next = host.text;
    for (let at = change.fromIndex; at !== change.toIndex; at += offset) {
      next = moveStep(next, [...where, at], offset);
    }
    host.commit(next, () => {
      for (let at = change.fromIndex; at !== change.toIndex; at += offset) {
        host.keys.moved(where, at, offset);
      }
    });
  }

  function remove(row: Row): void {
    host.commit(removeStep(host.text, pathOf(row)), () => host.keys.removed(row.list, row.index));
  }

  /** The names the cases or lists of a step hold, but the one at `except`. */
  function otherNames(names: readonly string[], except: number): string[] {
    return names.filter((_name, index) => index !== except);
  }
</script>

{#snippet slotHead(heading: Snippet, removeLabel: string, onRemove: () => void)}
  <div class="weft-step-list__slot-head">
    <div class="weft-step-list__slot-title">{@render heading()}</div>
    <Button variant="ghost" size="sm" aria-label={removeLabel} onclick={onRemove}>
      <Trash2 aria-hidden="true" />
    </Button>
  </div>
{/snippet}

{#snippet body(row: Row)}
  {@const step = row.step}
  {#if step.kind === 'branch'}
    {@const names = step.cases.map((entry) => entry.value)}
    <Input
      id={stepFieldId(row.address, 'title')}
      label={copy.stepNameLabel}
      aria-label={copy.stepName(row.where)}
      placeholder={copy.stepKinds.branch}
      size="sm"
      value={step.title}
      onValueChange={(next) => host.commit(setStepTitle(host.text, pathOf(row), next))}
    />
    <Input
      id={stepFieldId(row.address, 'on')}
      label={flow.onLabel}
      aria-label={flow.onLabelFor(row.where)}
      description={flow.onDescription}
      size="sm"
      variant="code"
      required
      {...host.errorOf(stepFieldId(row.address, 'on'))}
      value={step.on}
      onValueChange={(next) => host.commit(setStepField(host.text, pathOf(row), 'on', next))}
    />
    {#each step.cases as entry, caseIndex (caseIndex)}
      {@const slot = [...pathOf(row), 'cases', entry.value]}
      {@const named = caseWhere(entry.value, row.where)}
      <section class="weft-step-list__slot" aria-label={named}>
        {#snippet nameField()}
          <WorkflowSlotNameField
            id={stepFieldId(row.address, `case-${String(caseIndex + 1)}`)}
            label={flow.caseLabel}
            accessibleName={flow.caseLabelFor(named)}
            name={entry.value}
            taken={otherNames(names, caseIndex)}
            takenText={flow.caseTaken}
            onRename={(next) =>
              host.commit(setCaseValue(host.text, pathOf(row), entry.value, next), () =>
                host.keys.slotRenamed(slot, next),
              )}
          />
        {/snippet}
        {@render slotHead(nameField, flow.removeCase(entry.value), () =>
          host.commit(removeCase(host.text, pathOf(row), entry.value), () =>
            host.keys.slotRemoved(slot),
          ),
        )}
        {@render stepList(
          entry.steps,
          slot,
          caseListAddress(row.address, caseIndex),
          named,
          row.depth + 1,
        )}
      </section>
    {/each}
    <div class="weft-step-list__actions">
      <Button
        id={stepFieldId(row.address, 'add-case')}
        variant="secondary"
        size="sm"
        onclick={() => host.commit(addCase(host.text, pathOf(row)))}
      >
        {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
        {flow.addCase}
      </Button>
      {#if step.otherwise === null}
        <Button
          id={stepFieldId(row.address, 'add-otherwise')}
          variant="secondary"
          size="sm"
          onclick={() => host.commit(addOtherwise(host.text, pathOf(row)))}
        >
          {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
          {flow.addOtherwise}
        </Button>
      {/if}
    </div>
    {#if step.otherwise !== null}
      {@const slot = [...pathOf(row), 'otherwise']}
      {@const named = otherwiseWhere(row.where)}
      <section class="weft-step-list__slot" aria-label={named}>
        {#snippet otherwiseHeading()}
          <span class="weft-step-list__slot-text">{flow.otherwiseHeading}</span>
        {/snippet}
        {@render slotHead(otherwiseHeading, flow.removeOtherwise, () =>
          host.commit(removeOtherwise(host.text, pathOf(row)), () => host.keys.slotRemoved(slot)),
        )}
        {@render stepList(
          step.otherwise,
          slot,
          otherwiseListAddress(row.address),
          named,
          row.depth + 1,
        )}
      </section>
    {/if}
  {:else if step.kind === 'parallel'}
    {@const names = step.branches.map((entry) => entry.name)}
    <Input
      id={stepFieldId(row.address, 'title')}
      label={copy.stepNameLabel}
      aria-label={copy.stepName(row.where)}
      placeholder={copy.stepKinds.parallel}
      size="sm"
      value={step.title}
      onValueChange={(next) => host.commit(setStepTitle(host.text, pathOf(row), next))}
    />
    {#each step.branches as entry, branchIndex (branchIndex)}
      {@const slot = [...pathOf(row), 'branches', entry.name]}
      {@const named = branchWhere(entry.name, row.where)}
      <section class="weft-step-list__slot" aria-label={named}>
        {#snippet nameField()}
          <WorkflowSlotNameField
            id={stepFieldId(row.address, `branch-${String(branchIndex + 1)}`)}
            label={flow.branchLabel}
            accessibleName={flow.branchLabelFor(named)}
            name={entry.name}
            taken={otherNames(names, branchIndex)}
            takenText={flow.branchTaken}
            onRename={(next) =>
              host.commit(setBranchName(host.text, pathOf(row), entry.name, next), () =>
                host.keys.slotRenamed(slot, next),
              )}
          />
        {/snippet}
        {@render slotHead(nameField, flow.removeBranch(entry.name), () =>
          host.commit(removeBranch(host.text, pathOf(row), entry.name), () =>
            host.keys.slotRemoved(slot),
          ),
        )}
        {@render stepList(
          entry.steps,
          slot,
          branchListAddress(row.address, branchIndex),
          named,
          row.depth + 1,
        )}
      </section>
    {/each}
    <div class="weft-step-list__actions">
      <Button
        id={stepFieldId(row.address, 'add-branch')}
        variant="secondary"
        size="sm"
        onclick={() => host.commit(addBranch(host.text, pathOf(row)))}
      >
        {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
        {flow.addBranch}
      </Button>
    </div>
  {:else if step.kind === 'map'}
    {@const slot = [...pathOf(row), 'steps']}
    {@const named = bodyWhere(row.where)}
    <Input
      id={stepFieldId(row.address, 'title')}
      label={copy.stepNameLabel}
      aria-label={copy.stepName(row.where)}
      placeholder={copy.stepKinds.map}
      size="sm"
      value={step.title}
      onValueChange={(next) => host.commit(setStepTitle(host.text, pathOf(row), next))}
    />
    <div class="weft-step-list__pair">
      <Input
        id={stepFieldId(row.address, 'over')}
        label={flow.overLabel}
        aria-label={flow.overLabelFor(row.where)}
        description={flow.overDescription}
        size="sm"
        variant="code"
        required
        {...host.errorOf(stepFieldId(row.address, 'over'))}
        value={step.over}
        onValueChange={(next) => host.commit(setStepField(host.text, pathOf(row), 'over', next))}
      />
      <NumberInput
        id={stepFieldId(row.address, 'concurrency')}
        label={flow.concurrencyLabel}
        aria-label={flow.concurrencyLabelFor(row.where)}
        description={flow.concurrencyDescription}
        min={1}
        value={/^\d+$/.test(step.concurrency) ? Number(step.concurrency) : null}
        onValueChange={(next) => host.commit(setStepConcurrency(host.text, pathOf(row), next))}
      />
    </div>
    <section class="weft-step-list__slot" aria-label={named}>
      <p class="weft-step-list__slot-text">{flow.bodyHeading(step.over)}</p>
      {@render stepList(step.steps, slot, bodyListAddress(row.address), named, row.depth + 1)}
    </section>
  {:else}
    <WorkflowStepFields
      {step}
      path={pathOf(row)}
      address={row.address}
      where={row.where}
      stepKey={row.key}
    />
  {/if}
{/snippet}

{#snippet stepList(
  items: readonly BuilderStep[],
  where: ListPath,
  listAddress: string,
  listWhere: string | undefined,
  depth: number,
)}
  {@const rows = rowsOf(items, where, listAddress, listWhere, depth)}
  {#if rows.length > 0}
    <SortableList
      items={rows}
      getKey={(row: Row) => row.key}
      getItemLabel={(row: Row) => row.where}
      formatMoveUpLabel={copy.moveEarlier}
      formatMoveDownLabel={copy.moveLater}
      reorderMode="buttons"
      label={listWhere ?? copy.stepsHeading}
      onReorder={(_next: Row[], change) => reorder(where, change)}
      class={depth === 0
        ? 'weft-step-list weft-step-list--cards'
        : 'weft-step-list weft-step-list--rows'}
    >
      {#snippet children(row: Row, context)}
        <div
          class={depth === 0 ? 'weft-step-list__card' : 'weft-step-list__row'}
          data-step-kind={row.step.kind}
          data-step-address={row.address}
          data-problem={host.hasProblem(row.address) ? '' : undefined}
        >
          <div class="weft-step-list__head">
            <span class="weft-step-list__position">{row.position}</span>
            <span class="weft-step-list__kind">
              {row.step.kind === 'activity'
                ? host.activityTitle(row.step.handler)
                : copy.stepKinds[row.step.kind]}
            </span>
            <span class="weft-step-list__head-actions">
              {@render context.moveButtons?.()}
              <Button
                variant="ghost"
                size="sm"
                aria-label={copy.remove(row.where)}
                onclick={() => remove(row)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            </span>
          </div>
          {@render body(row)}
        </div>
      {/snippet}
    </SortableList>
  {/if}
  <div class="weft-step-list__add">
    <WorkflowAddStepMenu
      into={where}
      list={listAddress}
      name={listWhere === undefined ? copy.addLabel : copy.addTo(listWhere)}
    />
  </div>
{/snippet}

{@render stepList(steps, list, address, undefined, 0)}

<style>
  /* The list's own class is on a Cinder element, so the page names it globally. */
  :global(.weft-step-list) {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }

  :global(.weft-step-list--cards) {
    gap: var(--cinder-space-2);
  }

  .weft-step-list__card,
  .weft-step-list__row {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  /* The workflow's own steps are the one bordered box on any path down the page. */
  .weft-step-list__card {
    padding: var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }

  /* A step inside a card is a flat row, told from the next by a hairline. */
  .weft-step-list__row {
    padding-block: var(--cinder-space-3);
    border-block-end: 1px solid var(--cinder-border-muted);
  }

  /* A step with something to fix is outlined, so it is found without reading its fields. */
  .weft-step-list__card[data-problem] {
    border-color: var(--cinder-status-danger-border);
  }

  /* A flat row has no box to outline, so what is wrong with it reads in the color of its name. */
  .weft-step-list__row[data-problem] .weft-step-list__kind {
    color: var(--cinder-status-danger-text);
  }

  .weft-step-list__head {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  .weft-step-list__position {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    font-variant-numeric: tabular-nums;
  }

  .weft-step-list__kind {
    flex: 1 1 auto;
    font-weight: 600;
    min-width: 0;
  }

  .weft-step-list__head-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1);
    align-items: center;
    justify-content: flex-end;
  }

  /* The steps of a case or a list: a heading line, then the steps, behind one leading rule. */
  .weft-step-list__slot {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    padding-inline-start: var(--cinder-space-3);
    border-inline-start: 1px solid var(--cinder-border-muted);
    min-width: 0;
  }

  .weft-step-list__slot-head {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: end;
  }

  .weft-step-list__slot-title {
    flex: 1 1 auto;
    min-width: 0;
  }

  .weft-step-list__slot-text {
    margin: 0;
    font-weight: 600;
  }

  .weft-step-list__pair {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-step-list__pair > :global(*) {
    flex: 1 1 10rem;
    min-width: 0;
  }

  .weft-step-list__actions,
  .weft-step-list__add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  .weft-step-list__add {
    padding-block-start: var(--cinder-space-2);
  }
</style>

<script lang="ts">
  /**
   * `/workflows/new` (board PageWorkflowBuilder, "New workflow" and "Pristine"): the builder over a
   * new workflow's file, saved through `bureau.workflows.create`. On first open nothing is chosen
   * for the person: it starts when someone runs it, with one empty agent step that names no agent,
   * no title and no ID, and no Input or Output, so an untouched form cannot create a schedule. The
   * `name` in the text is the workflow's identifier, so it is read and not sent, as the edit page
   * does not send it either.
   *
   * Create workflow is always pressable. With something to fix it sends nothing and takes the
   * person to the first problem: the line the JSON stops being JSON on, an ID that is not an
   * identifier, is `new` (which is this page's address) or is taken, or the first field of a step
   * that is empty. A file the Bureau cannot write shows its words above the footer and keeps
   * everything typed; Create workflow is the retry. While it writes, the form is read-only and the
   * button reads Creating. A save lands on the new workflow's page. Leaving with what was typed
   * asks first.
   */
  import { Button, ConfirmDialog, PageHeader } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onMount, untrack } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { LeaveGuard, router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import {
    createDefinitionFromText,
    createWorkflowFile,
    isApplyFailure,
    isIdentifierTaken,
  } from '../../lib/workflow-files.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import WorkflowBuilder from './workflow-builder.svelte';
  import { workflowProblems } from './workflow-builder-problems.ts';

  const copy = WORKFLOW_COPY;
  const creator = copy.creator;
  const queryClient = useQueryClient();

  /**
   * What the builder starts with: no ID yet, a `manual` trigger, and one agent step with no agent
   * and no message, which the person fills in.
   */
  const TEMPLATE = JSON.stringify(
    {
      name: '',
      trigger: { kind: 'manual' },
      steps: [{ kind: 'activity', handler: 'agent', input: { agent: '', message: '' } }],
    },
    null,
    2,
  );

  let text = $state(TEMPLATE);
  /** Create workflow was pressed, so what is wrong is said at its fields from now on. */
  let checked = $state(false);
  /** The ID the Bureau said a file already has. */
  let takenId = $state<string>();
  /** The builder, which takes the person to the first problem. */
  let builder = $state<{ focusProblem: () => Promise<void> }>();
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  /**
   * The Bureau found a problem the page can point at (a taken ID). The form is read-only while the
   * save is in flight, and a read-only form cannot take focus, so the focus waits for the answer.
   */
  let focusAfterSave = $state(false);

  // Leaving with what was typed asks first; an untouched form leaves at once.
  const leaveGuard = new LeaveGuard(() => text !== TEMPLATE);
  $effect(() => leaveGuard.attach());

  function created(id: string): void {
    leaveGuard.release();
    void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
    router.navigate(workflowTypePath(id));
  }

  const save = createMutation(() => ({
    mutationFn: ({ id, definition }: { id: string; definition: Record<string, unknown> }) =>
      createWorkflowFile(id, definition),
    onMutate: () => {
      failure = null;
    },
    onSuccess: (_result, { id }) => created(id),
    onError: (error, { id }) => {
      // The Bureau wrote the file and the engine could not follow: it is there, and applies it again.
      if (isApplyFailure(error)) {
        created(id);
        return;
      }
      if (isIdentifierTaken(error)) {
        takenId = id;
        checked = true;
        focusAfterSave = true;
        return;
      }
      const fault = agentFaultOf(error);
      switch (fault.kind) {
        case 'forbidden':
          failure = { title: creator.saveFailed, message: copy.forbidden };
          return;
        case 'identifier-taken':
        case 'stale':
        case 'not-found':
          // A create names no hash and no existing file, and an agent's identifier is not a
          // workflow's, so none of these is a thing it can be told.
          failure = { title: creator.saveFailed, message: creator.saveFailed };
          return;
        case 'rejected':
        case 'other':
          failure = { title: creator.saveFailed, message: fault.message };
          return;
      }
    },
  }));

  $effect(() => {
    if (save.isPending || !focusAfterSave) return;
    focusAfterSave = false;
    untrack(() => void builder?.focusProblem());
  });

  function submit(): void {
    if (save.isPending) return;
    const parsed = createDefinitionFromText(text);
    const problems = workflowProblems(text, {
      mode: 'create',
      ...(takenId === undefined ? {} : { takenId }),
    });
    if (!parsed.ok || problems.length > 0) {
      checked = true;
      void builder?.focusProblem();
      return;
    }
    save.mutate({ id: parsed.id, definition: parsed.definition });
  }

  // ⌘Enter saves from anywhere on the page, a field included (`lib/shortcuts.ts`).
  onMount(() =>
    shortcuts.register({
      keys: ['Enter'],
      modifier: 'mod',
      label: creator.saveAction,
      group: copy.builder.shortcutGroup,
      scope: { route: '/workflows/new' },
      handler: () => submit(),
    }),
  );

  function cancel(): void {
    router.navigate('/workflows');
  }
</script>

<div class="ib-workflow" data-page="workflow-creator">
  <PageHeader title={creator.heading} headingLevel={1} description={creator.description} />

  <form class="ib-workflow__section" onsubmit={(event) => event.preventDefault()}>
    <WorkflowBuilder
      bind:this={builder}
      {text}
      mode="create"
      error=""
      showProblems={checked}
      {...takenId === undefined ? {} : { takenId }}
      saving={save.isPending}
      {failure}
      jsonId="workflow-creator-text"
      jsonLabel={creator.textLabel}
      jsonDescription={creator.textDescription}
      backHref="/workflows"
      onTextChange={(next) => {
        text = next;
      }}
    >
      {#snippet actions()}
        <Button variant="secondary" size="sm" disabled={save.isPending} onclick={cancel}
          >{creator.cancelAction}</Button
        >
        <Button
          data-changes
          type="button"
          onclick={() => submit()}
          variant="primary"
          size="sm"
          disabled={save.isPending}
          >{save.isPending ? creator.creatingAction : creator.saveAction}</Button
        >
      {/snippet}
    </WorkflowBuilder>
  </form>
</div>

<!-- Asked before what was typed is left behind (row 66h): Cancel, the breadcrumb, a link, back. -->
<ConfirmDialog
  bind:open={leaveGuard.asking}
  title={copy.builder.discard.title}
  description={copy.builder.discard.description}
  confirmLabel={copy.builder.discard.confirm}
  cancelLabel={copy.builder.discard.keep}
  destructive
  onConfirm={() => leaveGuard.leave()}
/>

<script lang="ts">
  /**
   * `/workflows/new` (board PageWorkflowBuilder, "New workflow" and "Pristine"): the builder over a
   * new workflow's file, saved through `bureau.workflows.create`. On first open nothing is chosen
   * for the person: it starts when someone runs it, with one empty agent step that names no agent,
   * no title and no ID, and no Input or Output, so an untouched form cannot create a schedule. The
   * `name` in the text is the workflow's identifier, so it is read and not sent, as the edit page
   * does not send it either. Text that is not JSON, a name that is not an identifier or is `new`
   * (which is this page's address), and a document the Bureau refuses, show the error and save
   * nothing; so does a name that is taken. A save lands on the new workflow's page.
   */
  import { Alert, Button, PageHeader } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { shortcuts } from '../../lib/shortcuts.ts';
  import {
    createDefinitionFromText,
    createWorkflowFile,
    isApplyFailure,
    isIdentifierTaken,
  } from '../../lib/workflow-files.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import WorkflowBuilder from './workflow-builder.svelte';

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
  /** Why the text cannot be saved, or the Bureau's words for a document it refused. */
  let validation = $state('');
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);

  const NAME_PROBLEMS = {
    'not-json': copy.editor.notJson,
    'not-object': copy.editor.notObject,
    'no-name': creator.noName,
    'invalid-name': creator.invalidName,
    'reserved-name': creator.reservedName,
  } as const;

  function created(id: string): void {
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
        validation = creator.taken(id);
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

  function submit(): void {
    if (save.isPending) return;
    const parsed = createDefinitionFromText(text);
    if (!parsed.ok) {
      validation = NAME_PROBLEMS[parsed.reason];
      return;
    }
    validation = '';
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

  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="ib-workflow__alert-title">{failure.title}</p>
      <p class="ib-workflow__alert-body">{failure.message}</p>
    </Alert>
  {/if}

  <form class="ib-workflow__section" onsubmit={(event) => event.preventDefault()}>
    <WorkflowBuilder
      {text}
      mode="create"
      error={validation}
      jsonId="workflow-creator-text"
      jsonLabel={creator.textLabel}
      jsonDescription={creator.textDescription}
      backHref="/workflows"
      onTextChange={(next) => {
        text = next;
        validation = '';
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
          disabled={save.isPending}>{creator.saveAction}</Button
        >
      {/snippet}
    </WorkflowBuilder>
  </form>
</div>

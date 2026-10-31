<script lang="ts">
  /**
   * `/workflows/new`: a new workflow's file as JSON, in Cinder's editor, seeded with a template of
   * a name, a description, a schedule trigger, and one agent step, and saved through
   * `bureau.workflows.create`. The `name` in the text is the workflow's identifier, so it is read
   * and not sent, as the edit page does not send it either. Text that is not JSON, a name that is
   * not an identifier or is `new` (which is this page's address), and a document the Bureau
   * refuses, show the error and save nothing; so does a name that is taken. A save lands on the
   * new workflow's page.
   */
  import { Alert, Button } from '@lostgradient/cinder';
  import { createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { onMount } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import { defaultAgentQuery } from '../../lib/default-agent.ts';
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
   * What the editor starts with: the smallest file the Bureau accepts that does something. Its
   * step names `agent`, the first agent that can run, or none (`''`) until one is known or when no
   * agent can run.
   */
  function templateFor(agent: string): string {
    return JSON.stringify(
      {
        name: creator.templateName,
        description: creator.templateDescription,
        trigger: { kind: 'schedule', spec: creator.templateSpec },
        steps: [
          {
            kind: 'activity',
            handler: 'agent',
            input: { agent, message: creator.templateMessage },
          },
        ],
      },
      null,
      2,
    );
  }

  let text = $state(templateFor(''));
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

  // The step names the first agent that can run once the host says which, unless the person has
  // already changed the text.
  onMount(() => {
    let cancelled = false;
    void (async () => {
      try {
        const agent = await queryClient.fetchQuery(defaultAgentQuery());
        if (!cancelled && agent !== null && text === templateFor('')) text = templateFor(agent);
      } catch {
        // The host did not say, so the step names no agent and the person chooses one.
      }
    })();
    return () => {
      cancelled = true;
    };
  });

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
  <h1 class="ib-workflows__title">{creator.heading}</h1>

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
      onTextChange={(next) => {
        text = next;
        validation = '';
      }}
    />
    <div class="ib-workflow__actions">
      <Button
        data-changes
        type="button"
        onclick={() => submit()}
        variant="primary"
        size="sm"
        disabled={save.isPending}>{creator.saveAction}</Button
      >
      <Button variant="secondary" size="sm" disabled={save.isPending} onclick={cancel}
        >{creator.cancelAction}</Button
      >
    </div>
  </form>
</div>

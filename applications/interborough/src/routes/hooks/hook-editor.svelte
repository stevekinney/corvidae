<script lang="ts">
  /**
   * `/hooks/new` and `/hooks/:hook`: the editor that makes a hook or changes one, as three labelled
   * steps down the page. 1 When: the events the hook listens to, from a searchable picker. 2 Then:
   * what it does (send a signed message to a web address, start a workflow, or notify the owner) and
   * the fields of that action. 3 Check: the hook as a sentence, its name, Save, and Send a test
   * event. The hook's recent deliveries are beside the steps as plain lines.
   *
   * Send a test event is a real request: it posts one signed test message to the saved web address.
   * Only a hook that sends a signed message can send one, because the Bureau refuses the others (a
   * test would start a real workflow or write a real notification). The signing secret is never
   * shown: an existing hook opens with the field empty, and leaving it empty keeps the secret.
   *
   * A hook that changed since the page read it is refused when saved, and the page says so and reads
   * it again. A home that keeps hooks off says so in place of the editor (`hooks-unavailable.svelte`).
   */
  import {
    Alert,
    Button,
    ConfirmDialog,
    EmptyState,
    Input,
    PageHeader,
    Select,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import { STALE_COPY } from '../../app/copy.ts';
  import { showFault, showToast } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import {
    createHook,
    deleteHook,
    getHook,
    listHookEventKinds,
    listHooks,
    testHook,
    updateHook,
    HOOK_ACTION_TYPES,
    type Hook,
    type HookActionType,
  } from '../../lib/bureau-hooks.ts';
  import { classifyFault, faultTreatment } from '../../lib/faults.ts';
  import { hookPath } from '../../lib/identifier-paths.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { listWorkflowFiles } from '../../lib/workflow-files.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import { HookFormState } from './hook-form-state.svelte.ts';
  import HookDeliveries from './hook-deliveries.svelte';
  import HookEventPicker from './hook-event-picker.svelte';
  import { eventRefusal, eventWords, hookSentence } from './hook-presentation.ts';
  import HooksUnavailable from './hooks-unavailable.svelte';

  const copy = HOOKS_COPY.editor;
  const LIST_PATH = '/hooks';
  const queryClient = useQueryClient();

  const isNew = $derived(router.current.route?.pattern === '/hooks/new');
  const hookId = $derived(router.current.params['hook'] ?? '');
  // The outlet keys a route by its path, so this editor belongs to one address for its life.
  // svelte-ignore state_referenced_locally
  const form = new HookFormState(isNew);

  const existing = createQuery(
    () => ({
      queryKey: queryKeys.hooks.detail(hookId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getHook(hookId, { signal }),
      enabled: !isNew,
      retry: false,
    }),
    undefined,
  );
  /** A home that keeps hooks off answers the list as it answers every hook call; the new-hook page asks it. */
  const availability = createQuery(
    () => ({
      queryKey: queryKeys.hooks.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listHooks({ signal }),
      enabled: isNew,
      retry: false,
    }),
    undefined,
  );
  const kinds = createQuery(
    () => ({
      queryKey: queryKeys.hooks.events(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listHookEventKinds({ signal }),
      retry: false,
    }),
    undefined,
  );
  const workflows = createQuery(
    () => ({
      queryKey: queryKeys.hooks.workflows(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listWorkflowFiles({ signal }),
      enabled: form.actionType === 'start-workflow',
      retry: false,
    }),
    undefined,
  );

  const unavailable = $derived(
    classifyFault(isNew ? availability.error : existing.error)?.kind === 'not-supported',
  );
  const hook = $derived(existing.data);

  // Fill the form from the hook once, and again whenever the Bureau holds a newer revision of it and
  // the person has typed nothing, or the revision is the one this page's own save returned. A newer
  // revision under a form with edits (a stale save, or a window-focus refetch) keeps the edits and
  // sets `changed`, and the page offers a reload instead of discarding them, a typed secret included.
  let loadedRevision = -1;
  /** The revision this page's last successful save wrote. */
  let savedRevision: number | null = null;
  /** The hook changed in the Bureau under a form with unsaved edits. */
  let changed = $state(false);
  $effect(() => {
    const current = hook;
    if (current === undefined) return;
    untrack(() => {
      if (current.revision === loadedRevision) return;
      if (loadedRevision !== -1 && form.dirty && current.revision !== savedRevision) {
        changed = true;
        return;
      }
      loadedRevision = current.revision;
      form.load(current);
      changed = false;
    });
  });

  /** Reads the hook again and fills the form from it, which discards what was typed. */
  async function reload(): Promise<void> {
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: queryKeys.hooks.detail(hookId),
        queryFn: ({ signal }: { signal: AbortSignal }) => getHook(hookId, { signal }),
        staleTime: 0,
        retry: false,
      });
      savedRevision = null;
      loadedRevision = fresh.revision;
      form.load(fresh);
      changed = false;
      stale = false;
      failure = null;
    } catch (error) {
      failure = `${copy.loadFailed} ${faultTreatment(error).message}`;
    }
  }

  const isPlugin = $derived(hook?.action.type === 'plugin');
  const sentence = $derived(
    isPlugin && hook !== undefined
      ? hookSentence(hook)
      : hookSentence({ events: form.events, action: form.draftAction }),
  );
  const actionOptions = $derived(
    HOOK_ACTION_TYPES.map((type) => ({ value: type, label: actionLabel(type) })),
  );
  const workflowOptions = $derived.by(() => {
    const ready = (workflows.data ?? [])
      .filter((file) => file.state === 'ready' && !file.paused)
      .map((file) => file.id);
    const ids =
      form.workflowId !== '' && !ready.includes(form.workflowId)
        ? [form.workflowId, ...ready]
        : ready;
    return [
      { value: '', label: copy.workflow.placeholder, disabled: true },
      ...ids.map((id) => ({ value: id, label: id })),
    ];
  });
  /** The chosen events the action cannot listen to: the action changed after they were chosen. */
  const refused = $derived(
    form.events.filter((kind) => {
      const entry = kinds.data?.find((candidate) => candidate.kind === kind);
      return entry !== undefined && eventRefusal(form.actionType, entry) !== undefined;
    }),
  );

  function actionLabel(type: HookActionType): string {
    switch (type) {
      case 'webhook':
        return copy.action.webhook;
      case 'start-workflow':
        return copy.action.startWorkflow;
      case 'notify':
        return copy.action.notify;
    }
  }

  /** The write that failed, said beside what was typed, so it is not also a toast. */
  let failure = $state<string | null>(null);
  let stale = $state(false);

  const saving = createMutation(() => ({
    mutationFn: async (): Promise<Hook> =>
      isNew || hook === undefined
        ? createHook(form.toInput())
        : updateHook(hook.id, loadedRevision, form.toChange(hook)),
    onMutate: () => {
      failure = null;
      stale = false;
    },
    onSuccess: async (saved) => {
      savedRevision = saved.revision;
      await queryClient.invalidateQueries({ queryKey: ['hooks'] });
      form.signingSecret = '';
      if (isNew) router.navigate(hookPath(saved.id));
      else showToast(copy.saved);
    },
    onError: (error: unknown) => {
      if (agentFaultOf(error).kind === 'stale') {
        stale = true;
        void queryClient.invalidateQueries({ queryKey: queryKeys.hooks.detail(hookId) });
        return;
      }
      failure = `${copy.saveFailed}. ${faultTreatment(error).message}`;
    },
  }));

  const testing = createMutation(() => ({
    mutationFn: () => testHook(hookId),
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['hooks'] }),
    onError: (error: unknown) => {
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.check.testFailed}. ${treatment.message}` });
    },
  }));

  let confirmingDelete = $state(false);
  const deletion = createMutation(() => ({
    mutationFn: () => deleteHook(hookId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['hooks'] });
      router.navigate(LIST_PATH);
    },
    onError: (error: unknown) => {
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.check.deleteFailed}. ${treatment.message}` });
    },
  }));

  const canSave = $derived(form.isValid && refused.length === 0 && !saving.isPending);
  const webhookAddress = $derived(hook?.action.type === 'webhook' ? hook.action.url : undefined);

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    if (canSave) saving.mutate();
  }

  function leave(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#if unavailable}
  <HooksUnavailable />
{:else}
  <section
    class="ib-hook-editor"
    aria-label={isNew ? copy.newTitle : copy.editTitle}
    data-page="hook-editor"
  >
    <PageHeader
      title={isNew ? copy.newTitle : copy.editTitle}
      description={isNew ? copy.newDescription : copy.editDescription}
      headingLevel={1}
    >
      {#snippet actions()}
        <Button
          variant="ghost"
          size="sm"
          href={router.href(LIST_PATH)}
          onclick={(event) => leave(event, LIST_PATH)}>{copy.backToList}</Button
        >
      {/snippet}
    </PageHeader>

    {#if !isNew && existing.isError}
      <Alert variant="danger">{copy.loadFailed}</Alert>
    {:else if !isNew && hook === undefined}
      <p class="ib-hook-editor__loading" role="status">{copy.loading}</p>
    {:else}
      <div class="ib-hook-editor__layout">
        <form class="ib-hook-editor__steps" onsubmit={submit} novalidate>
          <section class="ib-hook-step" aria-labelledby="ib-hook-step-when">
            <h2 id="ib-hook-step-when" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.when.number}</span>
              {copy.steps.when.title}
            </h2>
            <HookEventPicker
              kinds={kinds.data ?? []}
              action={form.actionType}
              bind:events={form.events}
            />
            {#if kinds.isError}
              <Alert variant="danger">{copy.event.loadFailed}</Alert>
            {/if}
            {#if refused.length > 0}
              <Alert variant="warning" data-testid="hook-refused-events">
                {refused.map(eventWords).join(', ')}: {form.actionType === 'notify'
                  ? copy.event.notifyLoop
                  : copy.event.workflowLoop}
              </Alert>
            {/if}
          </section>

          <section class="ib-hook-step" aria-labelledby="ib-hook-step-then">
            <h2 id="ib-hook-step-then" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.what.number}</span>
              {copy.steps.what.title}
            </h2>
            {#if isPlugin && hook !== undefined}
              <p class="ib-hook-editor__plain">{copy.action.plugin}</p>
            {:else}
              <Select
                id="ib-hook-action"
                label={copy.action.label}
                description={isNew ? copy.action.choose : copy.action.fixed}
                disabled={!isNew}
                options={actionOptions}
                value={form.actionType}
                onchange={(event) =>
                  (form.actionType = event.currentTarget.value as HookActionType)}
              />
              {#if form.actionType === 'webhook'}
                <Input
                  id="ib-hook-url"
                  type="url"
                  label={copy.webhook.urlLabel}
                  description={copy.webhook.urlDescription}
                  {...form.urlProblem === undefined ? {} : { error: form.urlProblem }}
                  autocomplete="off"
                  bind:value={form.url}
                />
                <Input
                  id="ib-hook-secret"
                  type="password"
                  label={copy.webhook.secretLabel}
                  description={isNew
                    ? copy.webhook.secretNewDescription
                    : copy.webhook.secretKeepDescription}
                  {...form.secretProblem === undefined ? {} : { error: form.secretProblem }}
                  autocomplete="new-password"
                  bind:value={form.signingSecret}
                />
              {:else if form.actionType === 'start-workflow'}
                {#if workflows.isSuccess && workflowOptions.length === 1}
                  <EmptyState
                    kind="first-use"
                    title={copy.workflow.none}
                    description={copy.workflow.noneDescription}
                    headingLevel={3}
                  >
                    {#snippet action()}
                      <Button
                        variant="secondary"
                        size="sm"
                        href={router.href('/workflows/new')}
                        onclick={(event) => leave(event, '/workflows/new')}
                        >{copy.workflow.create}</Button
                      >
                    {/snippet}
                  </EmptyState>
                {:else}
                  <Select
                    id="ib-hook-workflow"
                    label={copy.workflow.label}
                    description={copy.workflow.description}
                    disabled={workflows.isPending}
                    options={workflowOptions}
                    value={form.workflowId}
                    onchange={(event) => (form.workflowId = event.currentTarget.value)}
                  />
                  <Select
                    id="ib-hook-workflow-input"
                    label={copy.workflow.inputLabel}
                    options={[
                      { value: 'payload', label: copy.workflow.inputPayload },
                      { value: 'event', label: copy.workflow.inputEvent },
                    ]}
                    value={form.workflowInput}
                    onchange={(event) =>
                      (form.workflowInput =
                        event.currentTarget.value === 'event' ? 'event' : 'payload')}
                  />
                {/if}
              {:else}
                <Input
                  id="ib-hook-title"
                  label={copy.notify.titleLabel}
                  description={copy.notify.titleDescription}
                  bind:value={form.title}
                />
              {/if}
            {/if}
          </section>

          <section class="ib-hook-step" aria-labelledby="ib-hook-step-check">
            <h2 id="ib-hook-step-check" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.check.number}</span>
              {copy.steps.check.title}
            </h2>
            <p class="ib-hook-editor__sentence" data-testid="hook-sentence">
              <span class="ib-hook-editor__sentence-label">{copy.check.sentenceLabel}</span>
              {sentence}
            </p>
            <Input
              id="ib-hook-name"
              label={copy.check.nameLabel}
              description={copy.check.nameDescription}
              bind:value={form.name}
            />
            {#if failure !== null}
              <Alert variant="danger" data-testid="hook-failure">{failure}</Alert>
            {/if}
            {#if changed}
              <Alert variant="warning" data-testid="hook-changed">
                <p class="ib-hook-editor__alert-title">{STALE_COPY.title(hookId)}</p>
                <p class="ib-hook-editor__alert-body">{copy.changedDescription}</p>
                <Button variant="secondary" size="sm" onclick={() => void reload()}
                  >{copy.reload}</Button
                >
              </Alert>
            {:else if stale}
              <Alert
                variant="warning"
                dismissible
                onDismiss={() => (stale = false)}
                data-testid="hook-stale"
              >
                <p class="ib-hook-editor__alert-title">{STALE_COPY.title(hookId)}</p>
                <p class="ib-hook-editor__alert-body">{copy.staleDescription}</p>
              </Alert>
            {/if}
            <div class="ib-hook-editor__actions">
              <Button type="submit" variant="primary" disabled={!canSave}
                >{isNew ? copy.check.create : copy.check.save}</Button
              >
              {#if !isNew}
                <Button
                  data-changes
                  variant="secondary"
                  disabled={webhookAddress === undefined || testing.isPending}
                  onclick={() => testing.mutate()}>{copy.check.test}</Button
                >
                <Button data-changes variant="ghost" onclick={() => (confirmingDelete = true)}
                  >{copy.check.delete}</Button
                >
              {/if}
            </div>
            <p class="ib-hook-editor__hint">
              {#if isNew}
                {copy.check.testNeedsSave}
              {:else if webhookAddress === undefined}
                {copy.check.testWebhookOnly}
              {:else}
                {copy.check.testReaches(webhookAddress)}
              {/if}
            </p>
          </section>
        </form>
        {#if !isNew}
          <aside class="ib-hook-editor__aside">
            <HookDeliveries {hookId} />
          </aside>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.check.deleteTitle}
  description={copy.check.deleteDescription(sentence)}
  confirmLabel={copy.check.deleteConfirm}
  destructive
  onConfirm={() => deletion.mutate()}
/>

<style>
  .ib-hook-editor {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .ib-hook-editor__layout {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  @media (min-width: 900px) {
    .ib-hook-editor__layout:has(.ib-hook-editor__aside) {
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    }
  }

  .ib-hook-editor__steps {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .ib-hook-step {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-step__title {
    display: flex;
    align-items: center;
    gap: var(--cinder-space-2);
    margin: 0;
    font-size: var(--cinder-text-md);
    font-weight: 600;
  }

  .ib-hook-step__number {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    border: 1px solid var(--cinder-border);
    border-radius: 50%;
    font-size: var(--cinder-text-xs);
  }

  .ib-hook-editor__sentence {
    margin: 0;
    overflow-wrap: anywhere;
  }

  .ib-hook-editor__sentence-label {
    display: block;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .ib-hook-editor__plain,
  .ib-hook-editor__loading,
  .ib-hook-editor__hint {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .ib-hook-editor__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .ib-hook-editor__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .ib-hook-editor__alert-body {
    margin: 4px 0 0;
  }

  .ib-hook-editor__aside {
    min-width: 0;
  }
</style>

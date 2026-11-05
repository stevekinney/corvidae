<script lang="ts">
  /**
   * `/schedules/new`: the page that makes a schedule (COR-2018, rows 74a–75o and 06i–06k). A
   * schedule is a workflow on a timer, so the page asks in the order the sentence does: What runs,
   * the Input that workflow needs, When, the two policy selects, then the Name.
   *
   * The workflow is chosen from Cinder's picker combobox: Built in holds "Chat with an agent",
   * Recent the workflows the newest schedules start, and All workflows the rest, each with its
   * description under its name. Only the built-in chat asks for an agent, a message and whether
   * every run continues one chat; any other workflow asks for its own input, drawn from its
   * schema (an optional JSON field when it declares none), or says it takes none. When is the block
   * the run setup page shares, with its two policy selects. The Name starts as the workflow's
   * name (the agent's for a chat) until it is edited.
   *
   * Create stays enabled while a problem shows: pressing it moves focus to the first problem,
   * with its message at the field. It waits only for what it cannot do without (the workflow list,
   * the chosen workflow's input fields, a create in flight), and the footer line says which. The
   * primary action is outside the input form, and a submit counts only when Create asked for it,
   * so Enter in a field never makes a schedule. A second ask while one is in flight is dropped
   * before the first `await`. While a create is in flight the fields stop taking edits and Cancel
   * stops the request and keeps the form. A refusal keeps everything where it was: the services'
   * field problems go on the fields they name, and any other failure is an alert above the
   * actions. Leaving the page after typing asks first.
   */
  import {
    Alert,
    Button,
    Combobox,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    FormField,
    formatTimeZoneLabel,
    Input,
    PageHeader,
    SectionHeading,
    Select,
    Skeleton,
    Textarea,
    Toggle,
    type ScheduleValue,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { tick } from 'svelte';

  import { RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { readScheduleAttention } from '../../lib/bureau-attention.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { createAgentSchedule } from '../../lib/bureau-schedules.ts';
  import { getClient } from '../../lib/client.ts';
  import { defaultAgentQuery } from '../../lib/default-agent.ts';
  import { faultTreatment, isNetworkFailure } from '../../lib/faults.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router, scheduleDetailPath } from '../../lib/router.svelte.ts';
  import { getPrincipalStore, scopeGate } from '../../lib/scopes.svelte.ts';
  import {
    CATALOG_STALE_TIME_MS,
    loadCatalog,
    resolveWorkflow,
  } from '../../lib/workflow-catalog.ts';
  import { workflowNewPath } from '../../lib/workflow-type-paths.ts';
  import { inputIssuesOf } from '../workflow-definitions/run-setup-model.ts';
  import WorkflowInput from '../workflow-definitions/workflow-input.svelte';
  import {
    agentScheduleInput,
    defaultNameOf,
    draftErrors,
    emptyDraft,
    emptyInputOf,
    engineScheduleArgs,
    footerLineOf,
    isChatDraft,
    isDraftStarted,
    newChatId,
    optionMatches,
    recentTypes,
    scheduleTargetOf,
    SLOW_CREATE_MS,
    takenNameOf,
    takesNoInput,
    workflowLabel,
    workflowOptions,
    type NewScheduleDraft,
    type NewScheduleOverlap,
  } from './new-schedule-model.ts';
  import { loadModelAgents } from './schedule-row-context.ts';
  import { createSchedule, fetchScheduleList } from './schedule-queries.ts';
  import ScheduleWhen from './schedule-when.svelte';

  const copy = SCHEDULE_COPY.create;
  const LIST_PATH = '/schedules';
  const PROVIDERS_PATH = '/settings/models';
  /** How long a read may take before its placeholder says so, in milliseconds. */
  const STILL_LOADING_MS = 10_000;
  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));

  const draft = $state<NewScheduleDraft>(emptyDraft());
  /** The page as it opened, to tell whether anything was typed. */
  const opened = $state.snapshot(draft);
  const errors = $derived(draftErrors(draft));
  const chat = $derived(isChatDraft(draft));
  /** Zone the next runs are shown in: the viewer's, as the Schedules list names it. */
  const zone = formatTimeZoneLabel(new Date(), { style: 'long' });

  const catalogKey = queryKeys.workflowCatalog.list();
  // The workflows the picker offers, and the schedules the newest of which fill Recent. A failure
  // of either leaves the built-in chat to choose, and the picker says the list is missing.
  const catalog = createQuery(
    () => ({
      queryKey: catalogKey,
      queryFn: ({ signal }) => loadCatalog(client, { signal }),
      staleTime: CATALOG_STALE_TIME_MS,
    }),
    undefined,
  );
  const existingKey = queryKeys.schedules.list({});
  const existing = createQuery(
    () => ({
      queryKey: existingKey,
      queryFn: () => fetchScheduleList(client, {}),
      retry: false,
    }),
    undefined,
  );
  /** Whether the person stopped waiting for the list, which then reads as one that failed. */
  let listCancelled = $state(false);
  const listLoading = $derived(catalog.isPending && !listCancelled);
  const listFailed = $derived(catalog.isError || listCancelled);
  const options = $derived(
    workflowOptions(
      catalog.data ?? [],
      recentTypes(
        (existing.data?.items ?? []).map(({ workflowType, createdAt }) => ({
          workflowType,
          createdAt,
        })),
      ),
    ),
  );
  const chosen = $derived(options.find((option) => option.value === draft.workflowType));
  const workflowName = $derived(chosen?.label ?? workflowLabel(draft.workflowType));

  function cancelList(): void {
    listCancelled = true;
    void queryClient.cancelQueries({ queryKey: catalogKey });
  }

  function retryList(): void {
    listCancelled = false;
    void catalog.refetch();
  }

  // The agents a chat may run. A Bureau that cannot list them leaves the name to be typed.
  const agents = createQuery(
    () => ({
      queryKey: queryKeys.agents.list(),
      queryFn: ({ signal }) => listAgents({ signal }),
      retry: false,
    }),
    undefined,
  );
  const agentNames = $derived(
    agents.isSuccess ? agents.data.map((agent) => agent.name) : undefined,
  );
  const defaultAgent = createQuery(() => ({ ...defaultAgentQuery(), enabled: chat }));

  // A chat starts with the agent the Home page starts with, until a person picks another.
  $effect(() => {
    if (chat && draft.agentName === '' && defaultAgent.data) draft.agentName = defaultAgent.data;
  });

  // Whether the chosen agent needs a model while no provider is connected, so it will not run.
  const blockedQuery = createQuery(
    () => ({
      queryKey: queryKeys.schedules.providerBlocked(draft.agentName),
      queryFn: async ({ signal }) => {
        const [attention, modelAgents] = await Promise.all([
          readScheduleAttention({ signal }),
          loadModelAgents([draft.agentName], { signal }),
        ]);
        return attention.noProvider && modelAgents.has(draft.agentName);
      },
      enabled: chat && draft.agentName !== '',
      retry: false,
    }),
    undefined,
  );
  const blocked = $derived(chat && blockedQuery.data === true);

  // The chosen workflow's own page, which says what its input looks like. It is the same read as
  // the workflow's page, so one answers the other from the cache.
  const resolution = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.detail(draft.workflowType),
      queryFn: async ({ signal }) =>
        (await resolveWorkflow(client, draft.workflowType, { signal })) ?? null,
      enabled: draft.workflowType !== '' && !chat,
    }),
    undefined,
  );
  /** What the chosen workflow's page says it can be scheduled with; `undefined` until it is read, or when it is gone. */
  const target = $derived(
    chat || draft.workflowType === '' || resolution.data === undefined || resolution.data === null
      ? undefined
      : scheduleTargetOf(draft.workflowType, resolution.data),
  );
  /** Whether the chosen workflow was read and cannot be scheduled from here: it is gone, or it cannot load. */
  const unavailable = $derived(
    !chat &&
      resolution.data !== undefined &&
      (resolution.data === null || target?.status !== 'ready'),
  );
  /** Whether the chosen workflow's input was read, so the page knows what to ask for. */
  const inputRead = $derived(target?.status === 'ready');
  /** The schema of the chosen workflow's input, or `undefined` when it declares none (the input is then optional JSON). */
  const inputSchema = $derived(target?.status === 'ready' ? target.schema : undefined);
  /** Whether the chosen workflow's schema says it takes no input, which is not the same as declaring none. */
  const noInput = $derived(inputRead && takesNoInput(inputSchema));
  /** Whether the chosen workflow's input fields are still being read. */
  const inputLoading = $derived(!chat && draft.workflowType !== '' && resolution.isPending);

  type Choice = NewScheduleDraft;

  let inputField = $state<ReturnType<typeof WorkflowInput<Choice>> | null>(null);
  let whenBlock = $state<ReturnType<typeof ScheduleWhen>>();
  let formRegion = $state<HTMLElement>();
  /** The label of the field the cadence builder shows a problem on, if any. */
  let whenProblem = $state<string | undefined>(undefined);

  // The name follows the workflow (the agent for a chat) until a person edits it.
  let nameEdited = $state(false);
  const agentWords = $derived(agentLabel(draft.agentName, agents.data));
  const startingName = $derived(
    defaultNameOf({ workflowType: draft.workflowType, agentName: agentWords }, workflowName),
  );
  $effect(() => {
    if (!nameEdited) draft.name = startingName;
  });
  /** Whether the Create the person pressed found a problem to show: until then no field reads as wrong. */
  let attempted = $state(false);
  /** The schedule that already has the name asked for. */
  let nameTaken = $state<{ readonly id: string; readonly name: string } | undefined>(undefined);
  /** The refusal was said on the input's own fields, so no alert repeats it. */
  let onFields = $state(false);
  /** Whether a create is in flight. It is set before the first `await`, so two asks cannot both start. */
  let creating = $state(false);
  /** Whether the create has taken longer than {@link SLOW_CREATE_MS}. */
  let slow = $state(false);
  let controller: AbortController | undefined;
  /** Leaving was chosen, or a schedule was made: the page no longer asks. */
  let leaving = false;

  $effect(() => {
    if (!creating) {
      slow = false;
      return;
    }
    const handle = setTimeout(() => {
      slow = true;
    }, SLOW_CREATE_MS);
    return () => clearTimeout(handle);
  });

  /** Rejects when `signal` aborts, so a Cancel returns the form even though a request cannot be recalled. */
  function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const stop = (): void => reject(new DOMException('Cancelled', 'AbortError'));
      if (signal.aborted) {
        stop();
        return;
      }
      signal.addEventListener('abort', stop, { once: true });
      work.then(resolve, reject);
    });
  }

  const creation = createMutation(() => ({
    mutationFn: async (variables: {
      readonly choice: Choice;
      readonly input: unknown;
      readonly signal: AbortSignal;
    }) => {
      const { choice, input, signal } = variables;
      if (isChatDraft(choice)) {
        const chatId = choice.continueChat ? newChatId() : undefined;
        const made = await abortable(
          createAgentSchedule(agentScheduleInput(choice, chatId), { signal }),
          signal,
        );
        return made.id;
      }
      const made = await abortable(
        createSchedule(client, engineScheduleArgs(choice, input)),
        signal,
      );
      return made.id;
    },
    onMutate: () => {
      onFields = false;
      inputField?.clear();
    },
    onSuccess: (id) => {
      leaving = true;
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
      router.navigate(scheduleDetailPath(id), { force: true });
    },
    onError: (error, variables) => {
      if (error instanceof DOMException && error.name === 'AbortError') return;
      // The input's fields exist only for a workflow that draws them: Svelte sets the binding back
      // to null when they unmount, so what was submitted decides, not what the binding last held.
      const refused =
        isChatDraft(variables.choice) || inputField === null ? null : inputIssuesOf(error);
      if (refused !== null && inputField !== null) {
        inputField.refuse(refused);
        onFields = true;
      }
    },
    onSettled: () => {
      creating = false;
      controller = undefined;
    },
  }));

  const failure = $derived(onFields ? undefined : creation.error);
  const failureMessage = $derived.by(() => {
    if (failure === null || failure === undefined) return undefined;
    if (failure instanceof DOMException && failure.name === 'AbortError') return undefined;
    return isNetworkFailure(failure)
      ? copy.failed.message
      : `${faultTreatment(failure).message} ${copy.failed.message.replace(/^Interborough didn’t answer\. /, '')}`;
  });

  /** The errors a person has been told about: none before Create is pressed, except a message that is too long. */
  const shown = $derived({
    workflowType: attempted ? errors.workflowType : undefined,
    agentName: attempted ? errors.agentName : undefined,
    message: draft.message === '' && !attempted ? undefined : errors.message,
    name: attempted || nameEdited ? errors.name : undefined,
  });

  /** Moves focus to the first field in the form that shows a problem, once the page has drawn it. */
  async function focusFirstProblem(): Promise<void> {
    await tick();
    formRegion?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }

  /**
   * The label of the field the footer says Create will move focus to. Only a problem that is on
   * screen before Create is pressed says so (a cron field out of range): a problem Create itself
   * found is already where focus went.
   */
  const problemField = $derived(whenProblem);

  const footerLine = $derived(
    footerLineOf({
      draft: { ...draft, agentName: agentWords },
      workflow: workflowName,
      creating,
      slow,
      waitingForWorkflows: listLoading,
      waitingForInput: inputLoading,
      blocked,
      problemField,
    }),
  );
  const canCreate = $derived(!writeGate.disabled && !listLoading && !inputLoading && !creating);

  /** Looks for a schedule that already has the name, in a read made now so a create that was lost is seen. */
  async function takenNow(name: string): Promise<typeof nameTaken> {
    try {
      const fresh = await queryClient.fetchQuery({
        queryKey: existingKey,
        queryFn: () => fetchScheduleList(client, {}),
        staleTime: 0,
      });
      return takenNameOf(name, fresh.items);
    } catch {
      return takenNameOf(name, existing.data?.items ?? []);
    }
  }

  /**
   * Makes the schedule once everything that comes before it has been checked, in the order the page
   * reads: the cadence, then the name, which must not be one a schedule already has.
   */
  async function proceed(input: unknown, choice: Choice): Promise<void> {
    if (creating) return;
    if (whenBlock?.isInvalid() === true) {
      whenBlock.focusProblem();
      return;
    }
    if (draftErrors(choice).name !== undefined) {
      await focusFirstProblem();
      return;
    }
    creating = true;
    const attempt = new AbortController();
    controller = attempt;
    const taken = await takenNow(choice.name);
    if (attempt.signal.aborted) return;
    if (taken !== undefined) {
      nameTaken = taken;
      creating = false;
      controller = undefined;
      await focusFirstProblem();
      return;
    }
    creation.mutate({ choice, input, signal: attempt.signal });
  }

  /** Create's ask. The input checks itself, and only the submit this ask made makes a schedule. */
  async function create(): Promise<void> {
    if (!canCreate) return;
    attempted = true;
    nameTaken = undefined;
    // The mutation reads the draft after its first `await`, so it gets a copy nothing can change.
    const choice = $state.snapshot(draft);
    const early = draftErrors(choice);
    if (
      early.workflowType !== undefined ||
      early.agentName !== undefined ||
      early.message !== undefined
    ) {
      await focusFirstProblem();
      return;
    }
    if (chat) {
      await proceed(undefined, choice);
      return;
    }
    if (noInput) {
      await proceed(emptyInputOf(inputSchema), choice);
      return;
    }
    // The page tells the person what Create does with a problem in the input: the form moves focus.
    if (unavailable || !inputRead) {
      await focusFirstProblem();
      return;
    }
    inputField?.request(choice);
  }

  /** Cancel: while a create is in flight it stops the request and keeps the form; otherwise it leaves. */
  function cancel(event: MouseEvent): void {
    if (creating) {
      event.preventDefault();
      controller?.abort();
      creating = false;
      return;
    }
    leave(event, LIST_PATH);
  }

  function chooseCadence(next: ScheduleValue): void {
    draft.cadence = next;
  }

  function leave(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  // Leaving after typing asks first. A back or forward the guard refuses puts the address back.
  const started = $derived(isDraftStarted(draft, opened));
  let discarding = $state(false);
  let destination = LIST_PATH;
  $effect(() =>
    router.guardLeaving((next) => {
      if (leaving || !started) return true;
      destination = next;
      discarding = true;
      return false;
    }),
  );

  function discardAndLeave(): void {
    leaving = true;
    router.navigate(destination, { force: true });
  }

  function warnBeforeUnload(event: BeforeUnloadEvent): void {
    if (started && !leaving) event.preventDefault();
  }

  /** The two choices of what happens when a fire is due while a run is going: skipping is the only one a chat that continues can take. */
  const overlapOptions = $derived(
    draft.continueChat && chat ? [{ value: 'skip', label: 'Skip this one' }] : undefined,
  );

  function chooseOverlap(next: string): void {
    draft.overlap = (next === 'allow' ? 'allow' : 'skip') satisfies NewScheduleOverlap;
  }

  function continueChanged(next: boolean): void {
    draft.continueChat = next;
    if (next) draft.overlap = 'skip';
  }

  function goTo(event: MouseEvent, path: string): void {
    leave(event, path);
  }
</script>

<svelte:window onbeforeunload={warnBeforeUnload} />

<section class="ib-schedule-new" aria-label={copy.title} data-page="schedule-new">
  <PageHeader title={copy.title} headingLevel={1} description={copy.description(zone)} />

  <fieldset class="ib-schedule-new__fields" disabled={creating} bind:this={formRegion}>
    <div class="ib-schedule-new__section">
      <SectionHeading level={2} title={copy.whatRunsHeading} />
      <Combobox
        id="ib-schedule-new-workflow"
        presentation="picker"
        groupCountVisible={false}
        label={copy.workflowLabel}
        placeholder={copy.workflowPlaceholder}
        searchPlaceholder={copy.workflowSearchPlaceholder}
        {options}
        filter={optionMatches}
        bind:value={draft.workflowType}
        loading={listLoading}
        loadingLabel={copy.workflowLoading}
        stillLoadingAfter={STILL_LOADING_MS}
        onCancel={cancelList}
        {...listFailed ? { loadError: copy.catalogFailed, onRetry: retryList } : {}}
        noMatchLabel={copy.noMatch}
        error={shown.workflowType ?? ''}
        required
      >
        {#snippet footer()}
          <span class="ib-schedule-new__picker-footer">
            {copy.noMatchFooter}
            <a
              href={router.href(workflowNewPath())}
              onclick={(event) => goTo(event, workflowNewPath())}>{copy.createOne}</a
            >
          </span>
        {/snippet}
      </Combobox>
    </div>

    {#if chat}
      <div class="ib-schedule-new__section" data-testid="new-schedule-chat-input">
        <SectionHeading
          level={2}
          title={copy.inputHeading}
          description={copy.inputLead(workflowName)}
        />
        {#if agents.isSuccess && agents.data.length === 0}
          <EmptyState
            kind="first-use"
            title={copy.noAgents.title}
            description={copy.noAgents.description}
            headingLevel={3}
          >
            {#snippet action()}
              <Button
                variant="primary"
                size="sm"
                href={router.href('/agents/new')}
                onclick={(event) => goTo(event, '/agents/new')}>{copy.noAgents.action}</Button
              >
            {/snippet}
          </EmptyState>
        {:else}
          {#if agentNames !== undefined}
            <FormField
              id="ib-schedule-new-agent"
              label={SCHEDULE_COPY.form.agentLabel}
              required
              error={shown.agentName ?? ''}
              {...blocked ? { warning: copy.needsProvider } : {}}
              warningAction={blocked ? connectProvider : undefined}
            >
              <Select
                id="ib-schedule-new-agent"
                bind:value={draft.agentName}
                required
                options={[
                  { value: '', label: SCHEDULE_COPY.form.agentPlaceholder, disabled: true },
                  ...agentNames.map((name) => ({
                    value: name,
                    label: agentLabel(name, agents.data),
                  })),
                ]}
              />
            </FormField>
          {:else if agents.isPending}
            <Skeleton height="3rem" />
          {:else}
            <Input
              id="ib-schedule-new-agent"
              label={SCHEDULE_COPY.form.agentLabel}
              description={SCHEDULE_COPY.form.agentFreeTextDescription}
              bind:value={draft.agentName}
              error={shown.agentName ?? ''}
              required
            />
          {/if}
          <Textarea
            id="ib-schedule-new-message"
            label={copy.messageLabel}
            description={copy.messageDescription}
            rows={3}
            required
            bind:value={draft.message}
            error={shown.message ?? ''}
          />
          <Toggle
            id="ib-schedule-new-continue"
            label={copy.continueLabel}
            description={copy.continueDescription}
            descriptionPlacement="below"
            checked={draft.continueChat}
            onValueChange={continueChanged}
          />
        {/if}
      </div>
    {:else if draft.workflowType !== ''}
      <div class="ib-schedule-new__section" data-testid="new-schedule-workflow-input">
        {#if resolution.isError && resolution.data === undefined}
          <SectionHeading level={2} title={copy.inputHeading} />
          <ErrorState
            variant="flat"
            title={copy.workflowFailed}
            description={faultTreatment(resolution.error).message}
            headingLevel={3}
            retryLabel={RETRY_LABEL}
            onRetry={() => void resolution.refetch()}
          />
        {:else if unavailable}
          <SectionHeading level={2} title={copy.inputHeading} />
          <ErrorState
            variant="flat"
            title={copy.workflowFailed}
            description={copy.workflowGone}
            headingLevel={3}
          />
        {:else if !inputRead}
          <SectionHeading
            level={2}
            title={copy.inputHeading}
            description={copy.inputLead(workflowName)}
          />
          <Skeleton
            variant="form"
            rows={2}
            label={copy.checking}
            stillLoadingAfter={STILL_LOADING_MS}
            onCancel={() => (draft.workflowType = '')}
          />
        {:else if noInput}
          <SectionHeading
            level={2}
            title={copy.inputHeading}
            description={copy.noInput(workflowName)}
          />
        {:else}
          <SectionHeading
            level={2}
            title={copy.inputHeading}
            description={copy.inputLead(workflowName)}
          />
          {#key draft.workflowType}
            <WorkflowInput
              bind:this={inputField}
              schema={inputSchema}
              onInput={proceed}
              formId="ib-schedule-new-input"
              jsonId="ib-schedule-new-json"
              testId="new-schedule-input"
            />
          {/key}
        {/if}
      </div>
    {/if}

    <div class="ib-schedule-new__section">
      <SectionHeading level={2} title={copy.whenHeading} />
      <ScheduleWhen
        bind:this={whenBlock}
        value={draft.cadence}
        onValueChange={chooseCadence}
        label={copy.whenLabel}
        overlap={draft.overlap}
        onOverlapChange={chooseOverlap}
        {overlapOptions}
        catchUp={draft.catchUp}
        onCatchUpChange={(next) => (draft.catchUp = next)}
        catchUpLabel={copy.catchUpLabel}
        onProblem={(field) => (whenProblem = field)}
      />
    </div>

    <FormField
      id="ib-schedule-new-name"
      label={copy.nameLabel}
      description={copy.nameDescription}
      required
      error={nameTaken !== undefined ? copy.nameTaken : (shown.name ?? '')}
      errorGlyph="error"
      errorAction={nameTaken !== undefined ? openTaken : undefined}
    >
      <Input
        id="ib-schedule-new-name"
        placeholder={copy.namePlaceholder}
        required
        bind:value={draft.name}
        oninput={() => {
          nameEdited = true;
          nameTaken = undefined;
        }}
      />
    </FormField>
  </fieldset>

  {#if failureMessage !== undefined}
    <Alert variant="danger" data-testid="new-schedule-failed">
      <strong>{copy.failed.title}</strong>
      {failureMessage}
    </Alert>
  {/if}

  <div class="ib-schedule-new__footer" data-testid="new-schedule-footer">
    <p class="ib-schedule-new__summary" data-testid="new-schedule-summary">{footerLine}</p>
    <div class="ib-schedule-new__actions">
      <Button variant="secondary" href={router.href(LIST_PATH)} onclick={cancel}
        >{copy.cancel}</Button
      >
      <Button
        data-changes
        variant="primary"
        disabled={!canCreate && !creating}
        title={writeGate.title}
        loading={creating}
        onclick={() => void create()}>{creating ? copy.creating : copy.submit}</Button
      >
    </div>
  </div>
</section>

{#snippet connectProvider()}
  <a href={router.href(PROVIDERS_PATH)} onclick={(event) => goTo(event, PROVIDERS_PATH)}
    >{copy.connectProvider}</a
  >
{/snippet}

{#snippet openTaken()}
  {#if nameTaken !== undefined}
    {@const path = scheduleDetailPath(nameTaken.id)}
    <a href={router.href(path)} onclick={(event) => goTo(event, path)}
      >{copy.openSchedule(nameTaken.name)}</a
    >
  {/if}
{/snippet}

<ConfirmDialog
  bind:open={discarding}
  title={copy.discard.title}
  description={copy.discard.description}
  confirmLabel={copy.discard.confirm}
  cancelLabel={copy.discard.keep}
  destructive
  onConfirm={discardAndLeave}
/>

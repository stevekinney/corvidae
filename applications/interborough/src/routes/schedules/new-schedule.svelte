<script lang="ts">
  /**
   * `/schedules/new`: the page that makes a schedule. A schedule is a workflow on a timer, so the
   * page asks in the order the sentence does: which workflow, with what input, and when.
   *
   * The workflow is chosen from a searchable picker: Built in holds "Chat with an agent", Recent
   * the workflows the newest schedules start, and All workflows the rest, each named in words and
   * described. Only the built-in chat asks for an agent and a message (and a chat to continue, in
   * place of a raw session identifier); any other workflow asks for its own input, drawn from its
   * schema, or says it takes none. When is the block the run setup page shares.
   *
   * The primary action is outside the input form, and a submit counts only when Create asked for
   * it, so Enter in a field never makes a schedule. A second ask while one is in flight is dropped
   * before the first `await`. A cadence field that is out of range refuses the save, because the
   * builder keeps the last valid cadence it emitted. A refusal keeps everything where it was: the
   * services' field problems go on the fields they name, and any other failure is a banner.
   */
  import {
    Alert,
    Button,
    Checkbox,
    Combobox,
    EmptyState,
    ErrorState,
    Input,
    PageHeader,
    RadioGroup,
    Select,
    Skeleton,
    Textarea,
    Toggle,
    type ScheduleValue,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { RETRY_LABEL, SCHEDULE_COPY } from '../../app/copy.ts';
  import { showFault } from '../../app/toast-host.svelte';
  import { listAgents, listContexts } from '../../lib/bureau-client.ts';
  import { createAgentSchedule } from '../../lib/bureau-schedules.ts';
  import { getClient } from '../../lib/client.ts';
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
  import { inputIssuesOf, runSetupTarget } from '../workflow-definitions/run-setup-model.ts';
  import WorkflowInput from '../workflow-definitions/workflow-input.svelte';
  import FaultBanner from './fault-banner.svelte';
  import {
    agentScheduleInput,
    draftErrors,
    emptyDraft,
    engineScheduleArgs,
    isChatDraft,
    isDraftValid,
    recentTypes,
    summaryOf,
    workflowOptions,
    optionMatches,
    type NewScheduleDraft,
  } from './new-schedule-model.ts';
  import { OVERLAP_POLICIES } from './overlap-policy.ts';
  import { REVISION_POLICIES } from './revision-policy.ts';
  import { createSchedule, fetchScheduleList, pauseSchedule } from './schedule-queries.ts';
  import ScheduleWhen from './schedule-when.svelte';

  const copy = SCHEDULE_COPY.create;
  const LIST_PATH = '/schedules';
  const client = getClient();
  const principal = getPrincipalStore();
  const queryClient = useQueryClient();
  const writeGate = $derived(scopeGate(principal, ['schedules:write']));

  const draft = $state<NewScheduleDraft>(emptyDraft());
  const errors = $derived(draftErrors(draft));
  const chat = $derived(isChatDraft(draft));

  // The workflows the picker offers, and the schedules the newest of which fill Recent. A failure
  // of either leaves the built-in chat to choose, and the page says the list is missing.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.list(),
      queryFn: ({ signal }) => loadCatalog(client, { signal }),
      staleTime: CATALOG_STALE_TIME_MS,
    }),
    undefined,
  );
  const existing = createQuery(
    () => ({
      queryKey: queryKeys.schedules.list({}),
      queryFn: () => fetchScheduleList(client, {}),
      retry: false,
    }),
    undefined,
  );
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

  /** What was typed in the picker, so a search that finds nothing can offer to create a workflow. */
  let search = $state('');
  const nothingFound = $derived(
    search.trim() !== '' && !options.some((option) => optionMatches(option, search)),
  );

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

  // The chats a schedule may continue: the newest the Bureau lists. A Bureau that cannot list them
  // leaves every run to start a chat of its own.
  const chats = createQuery(
    () => ({
      queryKey: queryKeys.contexts.picker(),
      queryFn: ({ signal }) => listContexts({ origin: 'chat', limit: 100 }, { signal }),
      retry: false,
      enabled: chat,
    }),
    undefined,
  );
  const chatOptions = $derived(
    (chats.data?.contexts ?? []).map((context) => ({
      value: context.id,
      label: context.title ?? context.lastMessagePreview ?? copy.chatUntitled,
      description: copy.chatAgent(context.agentName),
    })),
  );

  /** Picks the chat each run continues, which also fixes the agent: a chat has the one it started with. */
  function chooseChat(id: string): void {
    draft.chatId = id;
    const found = chats.data?.contexts.find((context) => context.id === id);
    if (found !== undefined) draft.agentName = found.agentName;
  }

  const continued = $derived(chats.data?.contexts.find((context) => context.id === draft.chatId));

  // The chosen workflow's own page, which says what its input looks like. It is the same read as the
  // workflow's page, so one answers the other from the cache.
  const resolution = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.detail(draft.workflowType),
      queryFn: async ({ signal }) =>
        (await resolveWorkflow(client, draft.workflowType, { signal })) ?? null,
      enabled: draft.workflowType !== '' && !chat,
    }),
    undefined,
  );
  /** Whether the chosen workflow was read and cannot be scheduled from here: it is gone, or it is not a code-defined workflow. */
  const unavailable = $derived(
    resolution.isSuccess &&
      (resolution.data === null ||
        runSetupTarget(draft.workflowType, resolution.data).status !== 'ready'),
  );
  /** The schema of the chosen workflow's input once it is read; `undefined` while it is not, and `null` for none. */
  const inputSchema = $derived.by(() => {
    if (chat || draft.workflowType === '') return undefined;
    if (resolution.data === undefined || resolution.data === null) return undefined;
    const target = runSetupTarget(draft.workflowType, resolution.data);
    return target.status === 'ready' ? (target.schema ?? null) : undefined;
  });

  type Choice = NewScheduleDraft;

  let inputField = $state<ReturnType<typeof WorkflowInput<Choice>>>();
  let whenBlock = $state<ReturnType<typeof ScheduleWhen>>();
  /** The cadence builder shows a field that is out of range. */
  let invalidCadence = $state(false);
  /** A save whose answer was lost, so a second ask could make a second schedule. */
  let maybeMade = $state(false);
  /** The refusal was said on the input's own fields, so no banner repeats it. */
  let onFields = $state(false);
  /**
   * Whether a create is in flight. It is set before the first `await`, because the mutation's own
   * `isPending` turns true a tick after `mutate`, and two asks can arrive in that tick.
   */
  let sending = false;

  const creation = createMutation(() => ({
    mutationFn: async (variables: { readonly choice: Choice; readonly input: unknown }) => {
      const { choice, input } = variables;
      if (isChatDraft(choice)) {
        const made = await createAgentSchedule(agentScheduleInput(choice));
        return { id: made.id, notPaused: false };
      }
      const made = await createSchedule(client, engineScheduleArgs(choice, input));
      if (!choice.startPaused) return { id: made.id, notPaused: false };
      // The schedule exists from here, so a refusal to turn it off must not read as a failed create.
      try {
        await pauseSchedule(client, made.id);
        return { id: made.id, notPaused: false };
      } catch {
        return { id: made.id, notPaused: true };
      }
    },
    onMutate: () => {
      maybeMade = false;
      onFields = false;
      inputField?.clear();
    },
    onSuccess: (made) => {
      void queryClient.invalidateQueries({ queryKey: ['schedules'] });
      void queryClient.invalidateQueries({ queryKey: ['workflow-catalog'] });
      if (made.notPaused)
        showFault({ kind: 'invalid', message: copy.pauseFailed, fieldErrors: [] });
      router.navigate(scheduleDetailPath(made.id));
    },
    onError: (error) => {
      const refused = inputField === undefined ? null : inputIssuesOf(error);
      if (refused !== null) {
        inputField?.refuse(refused);
        onFields = true;
        return;
      }
      // The request may have reached the host before the answer was lost, so a second ask could
      // make a second schedule: say it may have happened, and where to look.
      if (isNetworkFailure(error)) maybeMade = true;
    },
    onSettled: () => {
      sending = false;
    },
  }));

  const fault = $derived(maybeMade || onFields || invalidCadence ? undefined : creation.error);

  /** Whether the page has what it needs to ask: a valid draft, and for a workflow its input read. */
  const ready = $derived(isDraftValid(draft) && (chat || inputSchema !== undefined));
  const canCreate = $derived(ready && !writeGate.disabled && !creation.isPending);

  function begin(input: unknown, choice: Choice): void {
    if (sending) return;
    sending = true;
    creation.mutate({ choice, input });
  }

  /** Create's ask. The input checks itself, and only the submit this ask made makes a schedule. */
  function create(): void {
    if (sending || !canCreate) return;
    // The builder keeps the last cadence it emitted while a field is out of range, so the draft is
    // not the cadence on screen: refuse until what is shown is valid.
    invalidCadence = whenBlock?.isInvalid() === true;
    if (invalidCadence) return;
    // The mutation reads the draft after its first `await`, so it gets a copy nothing can change.
    const choice = $state.snapshot(draft);
    if (chat || inputSchema === null) {
      begin(undefined, choice);
      return;
    }
    inputField?.request(choice);
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

  /** The two choices of what happens when a fire is due while a run is going, for a chat. */
  const skipsOverlap = {
    get: () => draft.overlap !== 'allow',
    set: (skip: boolean) => {
      draft.overlap = skip ? 'skip' : 'allow';
    },
  };
</script>

<section class="ib-schedule-new" aria-label={copy.title} data-page="schedule-new">
  <PageHeader title={copy.title} headingLevel={1} description={copy.description} />

  <div class="ib-schedule-new__section">
    <h2 class="ib-schedule-new__heading">{copy.workflowHeading}</h2>
    <Combobox
      id="ib-schedule-new-workflow"
      label={copy.workflowLabel}
      placeholder={copy.workflowPlaceholder}
      {options}
      filter={optionMatches}
      bind:value={draft.workflowType}
      bind:textInputValue={search}
      required
    />
    {#if nothingFound}
      <p class="ib-schedule-new__note" data-testid="new-schedule-no-match">
        {copy.noMatch}
        <a
          href={router.href(workflowNewPath())}
          onclick={(event) => leave(event, workflowNewPath())}>{copy.createOne}</a
        >
      </p>
    {/if}
    {#if chosen !== undefined}
      <p class="ib-schedule-new__note" data-testid="new-schedule-workflow-description">
        {chosen.description}
      </p>
    {/if}
    {#if catalog.isError}
      <Alert variant="warning" data-testid="new-schedule-catalog-failed">
        <p class="ib-schedule-new__alert-title">{copy.catalogFailed.title}</p>
        <p class="ib-schedule-new__alert-message">{copy.catalogFailed.description}</p>
        <Button variant="secondary" size="sm" onclick={() => void catalog.refetch()}
          >{RETRY_LABEL}</Button
        >
      </Alert>
    {/if}
  </div>

  {#if chat}
    <div class="ib-schedule-new__section" data-testid="new-schedule-chat-input">
      <h2 class="ib-schedule-new__heading">{copy.inputHeading}</h2>
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
              onclick={(event) => leave(event, '/agents/new')}>{copy.noAgents.action}</Button
            >
          {/snippet}
        </EmptyState>
      {:else}
        {#if agentNames !== undefined}
          <Select
            id="ib-schedule-new-agent"
            label={SCHEDULE_COPY.form.agentLabel}
            description={continued === undefined
              ? SCHEDULE_COPY.form.agentDescription
              : copy.chatFixesAgent(continued.agentName)}
            bind:value={draft.agentName}
            disabled={continued !== undefined}
            required
            options={[
              { value: '', label: SCHEDULE_COPY.form.agentPlaceholder, disabled: true },
              ...agentNames.map((name) => ({ value: name, label: name })),
            ]}
          />
        {:else if agents.isPending}
          <Skeleton height="3rem" />
        {:else}
          <Input
            id="ib-schedule-new-agent"
            label={SCHEDULE_COPY.form.agentLabel}
            description={SCHEDULE_COPY.form.agentFreeTextDescription}
            bind:value={draft.agentName}
            disabled={continued !== undefined}
            required
          />
        {/if}
        <Textarea
          id="ib-schedule-new-message"
          label={SCHEDULE_COPY.form.inputLabel}
          description={SCHEDULE_COPY.form.inputDescription}
          rows={4}
          required
          bind:value={draft.message}
          error={draft.message === '' ? '' : (errors.message ?? '')}
        />
        {#if chats.isPending}
          <Skeleton height="3rem" />
        {:else}
          <Combobox
            id="ib-schedule-new-chat"
            label={copy.chatLabel}
            description={chats.isError ? copy.chatUnavailable : copy.chatDescription}
            placeholder={copy.chatPlaceholder}
            options={chatOptions}
            value={draft.chatId}
            onValueChange={chooseChat}
            disabled={chats.isError}
            error={errors.chat ?? ''}
          />
          {#if draft.chatId !== ''}
            <div>
              <Button variant="ghost" size="sm" onclick={() => (draft.chatId = '')}
                >{copy.chatClear}</Button
              >
            </div>
          {/if}
        {/if}
      {/if}
    </div>
  {:else if draft.workflowType !== ''}
    <div class="ib-schedule-new__section" data-testid="new-schedule-workflow-input">
      <h2 class="ib-schedule-new__heading">{copy.inputHeading}</h2>
      {#if resolution.isError}
        <ErrorState
          variant="flat"
          title={copy.workflowFailed}
          description={faultTreatment(resolution.error).message}
          headingLevel={3}
          retryLabel={RETRY_LABEL}
          onRetry={() => void resolution.refetch()}
        />
      {:else if unavailable}
        <ErrorState
          variant="flat"
          title={copy.workflowFailed}
          description={copy.workflowGone}
          headingLevel={3}
        />
      {:else if inputSchema === undefined}
        <div role="status" aria-busy="true" aria-label={copy.checking}>
          <Skeleton height="6rem" />
        </div>
      {:else if inputSchema === null}
        <p class="ib-schedule-new__note" data-testid="new-schedule-no-input">{copy.noInput}</p>
      {:else}
        {#key draft.workflowType}
          <WorkflowInput
            bind:this={inputField}
            schema={inputSchema}
            onInput={begin}
            formId="ib-schedule-new-input"
            jsonId="ib-schedule-new-json"
            testId="new-schedule-input"
          />
        {/key}
      {/if}
    </div>
  {/if}

  <div class="ib-schedule-new__section">
    <h2 class="ib-schedule-new__heading">{SCHEDULE_COPY.create.whenHeading}</h2>
    <ScheduleWhen
      bind:this={whenBlock}
      value={draft.cadence}
      onValueChange={chooseCadence}
      label={copy.whenLabel}
    />
  </div>

  <div class="ib-schedule-new__section">
    <h2 class="ib-schedule-new__heading">{copy.optionsHeading}</h2>
    <Input
      id="ib-schedule-new-description"
      label={copy.descriptionLabel}
      description={copy.descriptionDescription}
      bind:value={draft.description}
      error={errors.description ?? ''}
    />
    {#if chat}
      <Checkbox
        id="ib-schedule-new-skip-overlap"
        label={SCHEDULE_COPY.form.skipOverlapLabel}
        bind:checked={skipsOverlap.get, skipsOverlap.set}
      />
    {:else if draft.workflowType !== ''}
      <RadioGroup
        name="ib-schedule-new-overlap"
        label={copy.overlapLabel}
        variant="card"
        bind:value={
          () => draft.overlap,
          (next) => {
            const policy = OVERLAP_POLICIES.find((candidate) => candidate.value === next);
            if (policy !== undefined) draft.overlap = policy.value;
          }
        }
      >
        {#each OVERLAP_POLICIES as policy (policy.value)}
          <RadioGroup.Option
            id={`ib-schedule-new-overlap-${policy.value}`}
            value={policy.value}
            label={policy.label}
            description={policy.consequence}
          />
        {/each}
      </RadioGroup>
      <Toggle
        id="ib-schedule-new-catch-up"
        label={copy.catchUpLabel}
        bind:checked={draft.backfill}
      />
      <Toggle
        id="ib-schedule-new-start-paused"
        label={copy.startPausedLabel}
        bind:checked={draft.startPaused}
      />
      <p class="ib-schedule-new__note">{copy.startPausedDescription}</p>
      <Input
        id="ib-schedule-new-jitter"
        label={copy.jitterLabel}
        description={copy.jitterDescription}
        placeholder={copy.jitterPlaceholder}
        bind:value={draft.jitterText}
        error={errors.jitter ?? ''}
      />
      <RadioGroup
        name="ib-schedule-new-revision"
        label={copy.revisionLabel}
        variant="card"
        bind:value={
          () => draft.revisionPolicy,
          (next) => {
            const policy = REVISION_POLICIES.find((candidate) => candidate.value === next);
            if (policy !== undefined) draft.revisionPolicy = policy.value;
          }
        }
      >
        {#each REVISION_POLICIES as policy (policy.value)}
          <RadioGroup.Option
            id={`ib-schedule-new-revision-${policy.value}`}
            value={policy.value}
            label={policy.label}
            description={policy.consequence}
          />
        {/each}
      </RadioGroup>
    {/if}
  </div>

  {#if invalidCadence}
    <Alert variant="danger" dismissible onDismiss={() => (invalidCadence = false)}>
      {copy.invalidCadence}
    </Alert>
  {:else if maybeMade}
    <Alert variant="danger" data-testid="new-schedule-maybe-made">
      <p class="ib-schedule-new__alert-title">{SCHEDULE_COPY.lost.title}</p>
      <p class="ib-schedule-new__alert-message">{SCHEDULE_COPY.lost.description}</p>
      <p class="ib-schedule-new__alert-message">
        <a href={router.href(LIST_PATH)} onclick={(event) => leave(event, LIST_PATH)}
          >{SCHEDULE_COPY.lost.check}</a
        >
      </p>
    </Alert>
  {:else if fault}
    <FaultBanner treatment={faultTreatment(fault)} />
  {/if}

  <div class="ib-schedule-new__footer" data-testid="new-schedule-footer">
    <p class="ib-schedule-new__summary" data-testid="new-schedule-summary">{summaryOf(draft)}</p>
    <div class="ib-schedule-new__actions">
      <Button
        variant="ghost"
        href={router.href(LIST_PATH)}
        onclick={(event) => leave(event, LIST_PATH)}>{copy.cancel}</Button
      >
      <Button
        data-changes
        variant="primary"
        disabled={!canCreate}
        title={writeGate.title}
        loading={creation.isPending}
        onclick={create}>{copy.submit}</Button
      >
    </div>
  </div>
</section>

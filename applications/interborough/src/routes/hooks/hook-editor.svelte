<script lang="ts">
  /**
   * `/hooks/new` and `/hooks/:hook`: the editor that makes a hook or changes one, as three numbered
   * steps down the page, with the delivery log in a side rail (below the steps on a phone). A hook
   * that is not saved has an empty log, and a test event sent before the first save adds nothing to it.
   *
   * A hook that is saved opens with a header (`hook-editor-header.svelte`): its name, the real On
   * switch, a "More actions" menu holding Delete hook, the hook as a sentence, and its latest
   * delivery. The switch saves the moment it changes and says so in a toast with Undo; only Save hook
   * saves the steps. A new hook opens as "New hook" under "Pick an event, then what should happen."
   *
   * 1 When: the event, from a searchable picker (`hook-event-picker.svelte`), read-only once the hook
   * is saved, and Only for, which offers what that event can be limited to (`hook-only-for.svelte`).
   * 2 Then: what it does, as a segmented control (send a webhook to a URL, start a workflow, or notify
   * the owner) and the fields of that action. A saved webhook shows its signing secret masked with
   * Replace (`hook-secret-field.svelte`); a new one gets a secret the Bureau makes, shown once on the
   * hook's own page. 3 Check: the hook as a sentence in a quiet box, Save hook, and Send a test event,
   * with the result of a test, or of a failed save, directly under the buttons.
   *
   * Save hook is never held back by what is missing: pressing it names each problem beside its field,
   * moves focus to the first, and keeps everything typed. Send a test event is a real request that
   * posts one signed test message to the web address, and it works before the first save and saves
   * nothing. Only a webhook can send one, because the Bureau refuses the other actions (a test would
   * start a real workflow or write a real notification).
   *
   * A hook that changed since the page read it is refused when saved, and the page says so and reads
   * it again. A home that keeps hooks off says so in place of the editor (`hooks-unavailable.svelte`).
   * A remote home cannot hold a signing secret, so it does not offer a webhook. A hook that is gone
   * is the not-found page; a slow read shows placeholders for the title and the three steps, and
   * after ten seconds a status line with Cancel. On a phone the When and Then steps of a saved hook
   * are one-line summaries that open to their fields.
   *
   * `?agent=` on `/hooks/new` starts the hook limited to that agent: it is where an agent's Hooks tab
   * sends New hook.
   */
  import {
    Alert,
    Button,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    Input,
    Link,
    PageHeader,
    Segment,
    SegmentedControl,
    Select,
    Skeleton,
  } from '@lostgradient/cinder';
  import { Play, Trash2 } from '@lucide/svelte';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { tick, untrack } from 'svelte';

  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { PLUGIN_KINDS_COPY, RETRY_LABEL, STALE_COPY } from '../../app/copy.ts';
  import NotFoundState from '../../app/not-found-state.svelte';
  import { showFault, showToast } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import {
    createHook,
    deleteHook,
    getHook,
    listHookDeliveries,
    listHookEventKinds,
    listHooks,
    replaceHookSecret,
    testHook,
    testHookDraft,
    updateHook,
    HOOK_ACTION_TYPES,
    type Hook,
    type HookActionType,
  } from '../../lib/bureau-hooks.ts';
  import { hookActionKindId, listContributedKinds } from '../../lib/bureau-plugin-kinds.ts';
  import ContributedConfigurationForm from '../../lib/contributed-configuration-form.svelte';
  import { classifyFault, faultTreatment } from '../../lib/faults.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { hookPath } from '../../lib/identifier-paths.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { listWorkflowFiles } from '../../lib/workflow-files.ts';
  import { HOOKS_COPY } from './hook-copy.ts';
  import HookEditorHeader from './hook-editor-header.svelte';
  import {
    anyScopeOf,
    editorSentence,
    editorTitle,
    hookWriteReason,
    latestDelivery,
    testOutcome,
    thenSummary,
    whenSummary,
    type TestOutcome,
  } from './hook-editor-presentation.ts';
  import HookDeliveries from './hook-deliveries.svelte';
  import HookEventPicker from './hook-event-picker.svelte';
  import {
    HookFormState,
    type HookProblem,
    type HookProblemField,
  } from './hook-form-state.svelte.ts';
  import HookOnlyFor from './hook-only-for.svelte';
  import {
    eventOptionLabel,
    eventRefusal,
    eventWords,
    isScopeKind,
    scopeKindsFor,
  } from './hook-presentation.ts';
  import HookSecretField from './hook-secret-field.svelte';
  import { holdSecret, takeHeldSecret } from './hook-secret-once.ts';
  import HooksUnavailable from './hooks-unavailable.svelte';

  const copy = HOOKS_COPY.editor;
  const LIST_PATH = '/hooks';
  /** How long a read is let to finish before anything is drawn for it, which is Cinder's loading rule. */
  const LOADING_DELAY_MILLISECONDS = 300;
  /** How long a read runs before the placeholders say it is taking longer than usual. */
  const STILL_LOADING_MILLISECONDS = 10_000;
  /** How many deliveries the log reads; the header's latest delivery is the first of the same read. */
  const DELIVERIES_READ = 20;
  /** The element the header's Jump to log and See the payload move to. */
  const LOG_ID = 'ib-hook-log';
  const queryClient = useQueryClient();

  // hidden-label-allowed: the Then step's own heading is the visible label of the whole group
  const hiddenLabel = { labelVisible: false } as const;

  const isNew = $derived(router.current.route?.pattern === '/hooks/new');
  const hookId = $derived(router.current.params['hook'] ?? '');
  // The outlet keys a route by its path, so this editor belongs to one address for its life.
  // svelte-ignore state_referenced_locally
  const form = new HookFormState(isNew);
  // svelte-ignore state_referenced_locally
  if (isNew) {
    const agent = router.search.get('agent');
    if (agent !== null && agent !== '') {
      form.scopeKind = 'agent';
      form.scopeId = agent;
    }
  }
  /**
   * The signing secret of the hook this page was opened for, when the save that made it just
   * answered with one: shown revealed with its Copy button, once. Replace shows the next one the
   * same way. Leaving the page forgets it.
   */
  // svelte-ignore state_referenced_locally
  let revealedSecret = $state<string | null>(isNew ? null : (takeHeldSecret(hookId) ?? null));

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
      queryFn: ({ signal }: { signal: AbortSignal }) => listHooks(undefined, { signal }),
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
  /**
   * The action kinds running plugins contribute. A host that cannot say offers the built-in
   * actions alone: the answer only ever adds choices. Only a new hook chooses one, because the
   * kind of action is fixed once a hook is made.
   */
  const contributed = createQuery(
    () => ({
      queryKey: queryKeys.pluginKinds(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listContributedKinds({ signal }),
      enabled: isNew,
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
  /** The newest deliveries, read for the header's latest delivery; the log beside the steps reads the same. */
  const deliveries = createQuery(
    () => ({
      queryKey: queryKeys.hooks.deliveries(hookId),
      queryFn: ({ signal }: { signal: AbortSignal }) =>
        listHookDeliveries(hookId, DELIVERIES_READ, { signal }),
      enabled: !isNew,
      retry: false,
    }),
    undefined,
  );

  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }: { signal: AbortSignal }) => getHostPaths({ signal }),
      enabled: isNew,
      retry: false,
    }),
    undefined,
  );
  /** A remote home cannot hold a signing secret, so a new hook there cannot send a webhook. */
  const remote = $derived(hostPaths.data?.mode === 'remote');
  $effect(() => {
    if (remote && form.actionType === 'webhook') form.actionType = 'notify';
  });

  const unavailable = $derived(
    classifyFault(isNew ? availability.error : existing.error)?.kind === 'not-supported',
  );
  const notFound = $derived(!isNew && classifyFault(existing.error)?.kind === 'not-found');
  const hook = $derived(existing.data);

  // "Cancel" in the still-loading line stopped the first read, and "Try again" reads again.
  let loadStopped = $state(false);
  const stopped = $derived(!isNew && existing.isPending && loadStopped);
  const loading = $derived(!isNew && existing.isPending && !loadStopped);
  function stopLoading(): void {
    loadStopped = true;
    void queryClient.cancelQueries({ queryKey: queryKeys.hooks.detail(hookId) });
  }
  function readAgain(): void {
    loadStopped = false;
    void existing.refetch();
  }

  // Fill the form from the hook once, and again whenever the Bureau holds a newer revision of it and
  // the person has typed nothing, or the revision is the one this page's own save returned. A newer
  // revision under a form with edits (a stale save, or a window-focus refetch) keeps the edits and
  // sets `changed`, and the page offers a reload instead of discarding them.
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
  /** The kinds of subject the chosen events narrow by, which say what "any" covers in the sentence. */
  const allowedScopes = $derived(scopeKindsFor(form.events, kinds.data ?? []));
  const draftSentence = $derived(
    editorSentence(
      isPlugin && hook !== undefined
        ? { events: form.events, action: hook.action, scope: form.draftScope }
        : { events: form.events, action: form.draftAction, scope: form.draftScope },
      anyScopeOf(allowedScopes),
    ),
  );
  /** The hook as it is saved, which the header says: it is not what is typed and not yet saved. */
  const savedScopes = $derived(scopeKindsFor(hook?.events ?? [], kinds.data ?? []));
  const savedSentence = $derived(
    hook === undefined ? '' : editorSentence(hook, anyScopeOf(savedScopes)),
  );
  const title = $derived(
    isNew ? copy.newTitle : hook === undefined ? '' : editorTitle(hook, anyScopeOf(savedScopes)),
  );
  usePageLabel(() => ({
    path: hookPath(hookId),
    label: isNew || title === '' ? undefined : title,
  }));

  const now = $derived.by(() => {
    void deliveries.data;
    return Date.now();
  });
  const latest = $derived(deliveries.isSuccess ? latestDelivery(deliveries.data, now) : undefined);

  const contributedKinds = $derived(contributed.data?.reactions ?? []);
  const actionOptions = $derived([
    ...HOOK_ACTION_TYPES.map((type) => ({
      value: type,
      label: actionLabel(type),
      disabled: remote && type === 'webhook',
    })),
    ...contributedKinds.map((kind) => ({
      value: hookActionKindId(kind),
      label: PLUGIN_KINDS_COPY.hookAction(kind.plugin, kind.kind),
    })),
  ]);
  /** The contributed kind the form has chosen, with its description and configuration schema. */
  const chosenKind = $derived(
    form.contributedKind === null
      ? undefined
      : contributedKinds.find(
          (kind) =>
            kind.plugin === form.contributedKind?.plugin && kind.kind === form.contributedKind.kind,
        ),
  );
  const actionValue = $derived(
    form.contributedKind === null ? form.actionType : hookActionKindId(form.contributedKind),
  );

  function chooseAction(value: string): void {
    const kind = contributedKinds.find((candidate) => hookActionKindId(candidate) === value);
    if (kind === undefined) {
      form.contributedKind = null;
      form.contributedConfiguration = {};
      form.actionType = value as HookActionType;
      return;
    }
    form.contributedKind = { plugin: kind.plugin, kind: kind.kind };
    form.contributedConfiguration = {};
  }

  /** The workflows a hook can start: ready and not paused, with the one the hook holds kept even when it is not. */
  const workflowOptions = $derived.by(() => {
    const ready = (workflows.data ?? [])
      .filter((file) => file.state === 'ready' && !file.paused)
      .map((file) => file.id);
    const held = form.workflowId !== '' && !ready.includes(form.workflowId);
    const ids = held ? [form.workflowId, ...ready] : ready;
    return [
      { value: '', label: copy.workflow.placeholder, disabled: true },
      ...ids.map((id) => ({
        value: id,
        label:
          held && id === form.workflowId && workflowDeleted ? copy.workflow.deletedName(id) : id,
      })),
    ];
  });
  /** Whether the workflow the hook holds is gone: the list was read and holds no file by that name. */
  const workflowDeleted = $derived(
    form.actionType === 'start-workflow' &&
      form.workflowId !== '' &&
      workflows.isSuccess &&
      !workflows.data.some((file) => file.id === form.workflowId),
  );
  const chosenWorkflowDescription = $derived(
    workflows.data?.find((file) => file.id === form.workflowId)?.description ?? undefined,
  );

  /** The chosen events the action cannot listen to: the action changed after they were chosen. */
  const refused = $derived(
    form.events.filter((kind) => {
      const entry = kinds.data?.find((candidate) => candidate.kind === kind);
      return entry !== undefined && eventRefusal(form.effectiveType, entry) !== undefined;
    }),
  );

  /** Whether the kind on the form is one every chosen event can be told by; the Bureau refuses otherwise. */
  const scopeRefused = $derived(
    kinds.isSuccess &&
      isScopeKind(form.scopeKind) &&
      form.events.length > 0 &&
      !scopeKindsFor(form.events, kinds.data).includes(form.scopeKind),
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

  /** The order the steps ask for things in, which decides the problem that takes focus first. */
  const FIELD_ORDER: readonly HookProblemField[] = ['event', 'only-for', 'url', 'workflow', 'name'];
  /** The control each field's problem moves focus to. */
  const FIELD_IDS: Readonly<Record<HookProblemField, string>> = {
    event: 'ib-hook-event',
    'only-for': 'ib-hook-only-for',
    url: 'ib-hook-url',
    workflow: 'ib-hook-workflow',
    name: 'ib-hook-name',
  };

  /** Everything that stops the hook being saved, first problem first: the form's own and what the Bureau would refuse. */
  const problems = $derived.by((): HookProblem[] => {
    const found = [...form.problems];
    if (refused.length > 0) {
      found.push({
        field: 'event',
        message: `${refused.map(eventWords).join(', ')}: ${
          form.actionType === 'notify' ? copy.event.notifyLoop : copy.event.workflowLoop
        }`,
      });
    }
    if (scopeRefused) found.push({ field: 'only-for', message: copy.onlyFor.refused });
    if (workflowDeleted) found.push({ field: 'workflow', message: copy.workflow.deleted });
    return found.toSorted(
      (left, right) => FIELD_ORDER.indexOf(left.field) - FIELD_ORDER.indexOf(right.field),
    );
  });
  /** Whether Save hook was pressed while something was missing, so empty required fields say so. */
  let attempted = $state(false);
  /** What a field says is wrong with it, once Save hook was pressed. */
  function problemOf(field: HookProblemField): string | undefined {
    return attempted ? problems.find((problem) => problem.field === field)?.message : undefined;
  }
  /** An address that cannot be sent is said as it is typed; an empty one waits for Save hook. */
  const urlError = $derived(form.urlProblem ?? problemOf('url'));
  /** A workflow that was deleted is said at once, beside the old name the field keeps. */
  const workflowError = $derived(workflowDeleted ? copy.workflow.deleted : problemOf('workflow'));
  const nameError = $derived(problemOf('name'));

  /** On a phone the When and Then steps of a saved hook are summaries until they are opened. */
  let whenOpen = $state(false);
  let thenOpen = $state(false);
  const compactWhen = $derived(phoneViewport.current && !isNew && !whenOpen);
  const compactThen = $derived(phoneViewport.current && !isNew && !thenOpen);

  /** Moves focus to the control of a problem, opening the step it is in first when the phone folded it. */
  async function focusProblem(problem: HookProblem): Promise<void> {
    if (problem.field === 'event' || problem.field === 'only-for') whenOpen = true;
    if (problem.field === 'url' || problem.field === 'workflow') thenOpen = true;
    await tick();
    const subject =
      problem.field === 'only-for' && form.scopeKind !== '' && form.scopeId === ''
        ? 'ib-hook-only-for-subject'
        : FIELD_IDS[problem.field];
    document.getElementById(subject)?.focus();
  }

  /** The write that failed, said beside what was typed, so it is not also a toast. */
  let failure = $state<string | null>(null);
  let stale = $state(false);

  const saving = createMutation(() => ({
    mutationFn: async (): Promise<Hook & { signingSecret?: string | null }> =>
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
      if (isNew) {
        if (saved.signingSecret !== undefined && saved.signingSecret !== null) {
          holdSecret(saved.id, saved.signingSecret);
        }
        router.navigate(hookPath(saved.id));
      } else showToast(copy.saved);
    },
    onError: (error: unknown) => {
      if (agentFaultOf(error).kind === 'stale') {
        stale = true;
        void queryClient.invalidateQueries({ queryKey: queryKeys.hooks.detail(hookId) });
        return;
      }
      failure = `${copy.saveFailed} ${hookWriteReason(error)} ${copy.saveFailedKept}`;
    },
  }));

  /**
   * Keeps what a write that changed the hook alone answered (the switch, a new secret) as the hook
   * the page holds. When the form was in step with the hook before the write it stays in step, so
   * what is typed is not discarded and the next Save names the new revision; a form that was behind
   * keeps its warning.
   */
  function adopt(before: Hook, saved: Hook): void {
    if (loadedRevision === before.revision) loadedRevision = saved.revision;
    queryClient.setQueryData(queryKeys.hooks.detail(hookId), saved);
    void queryClient.invalidateQueries({ queryKey: ['hooks'] });
  }

  /** A write the Bureau refused for the hook having changed: the page says so and reads it again. */
  function refuseStale(): void {
    stale = true;
    void queryClient.invalidateQueries({ queryKey: queryKeys.hooks.detail(hookId) });
  }

  const switching = createMutation(() => ({
    mutationFn: (input: { hook: Hook; enabled: boolean; undoing: boolean }) =>
      updateHook(input.hook.id, input.hook.revision, { enabled: input.enabled }),
    onSuccess: (saved, input) => {
      adopt(input.hook, saved);
      if (input.undoing) return;
      const name = editorTitle(saved, anyScopeOf(scopeKindsFor(saved.events, kinds.data ?? [])));
      showToast(saved.enabled ? copy.toggled.on(name) : copy.toggled.off(name), {
        undo: () => switching.mutate({ hook: saved, enabled: input.hook.enabled, undoing: true }),
      });
    },
    onError: (error: unknown) => {
      if (agentFaultOf(error).kind === 'stale') {
        refuseStale();
        return;
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.hooks.detail(hookId) });
      const treatment = faultTreatment(error);
      showFault({ ...treatment, message: `${copy.toggled.failed}. ${treatment.message}` });
    },
  }));

  function toggle(next: boolean): void {
    if (hook === undefined || switching.isPending) return;
    switching.mutate({ hook, enabled: next, undoing: false });
  }

  let secretFailure = $state<string | null>(null);
  const replacing = createMutation(() => ({
    mutationFn: (target: Hook) => replaceHookSecret(target.id, target.revision),
    onMutate: () => {
      secretFailure = null;
    },
    onSuccess: (result, target) => {
      const { signingSecret, ...saved } = result;
      adopt(target, saved);
      revealedSecret = signingSecret;
    },
    onError: (error: unknown) => {
      if (agentFaultOf(error).kind === 'stale') {
        refuseStale();
        return;
      }
      secretFailure = `${copy.webhook.secretReplaceFailed}. ${hookWriteReason(error)}`;
    },
  }));

  /** What the last test event came to, shown under the buttons. */
  let testResult = $state<TestOutcome | null>(null);
  const testing = createMutation(() => ({
    mutationFn: async (): Promise<TestOutcome> => {
      // A hook that is saved tests the address it holds; a new one tests the address typed, and
      // nothing is saved for it.
      if (isNew || hook === undefined) {
        const address = form.url.trim();
        return testOutcome(await testHookDraft({ url: address }), address, false);
      }
      const address = hook.action.type === 'webhook' ? hook.action.url : '';
      return testOutcome(await testHook(hook.id), address, true);
    },
    onMutate: () => {
      testResult = null;
    },
    onSuccess: (outcome) => {
      testResult = outcome;
    },
    onError: (error: unknown) => {
      testResult = { ok: false, text: `${copy.check.testFailed} ${hookWriteReason(error)}` };
    },
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['hooks'] }),
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

  /** The address a saved webhook sends to, or `undefined` for any other action. */
  const webhookAddress = $derived(hook?.action.type === 'webhook' ? hook.action.url : undefined);
  /** Whether Send a test event can be pressed: only a webhook sends one. */
  const canTest = $derived(
    !testing.isPending && (isNew ? form.effectiveType === 'webhook' : webhookAddress !== undefined),
  );
  const testHint = $derived(
    form.effectiveType === 'webhook' && (isNew || webhookAddress !== undefined)
      ? undefined
      : copy.check.testWebhookOnly,
  );

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    // A contributed action's fields are a form of their own inside this one; its submit is not a save.
    if (event.target !== event.currentTarget) return;
    if (saving.isPending) return;
    const first = problems[0];
    if (first !== undefined) {
      attempted = true;
      await focusProblem(first);
      return;
    }
    saving.mutate();
  }

  /** Sends a test event. A new hook needs a usable address first, which it asks for the way Save does. */
  async function sendTest(): Promise<void> {
    if (!canTest) return;
    const address = problems.find((problem) => problem.field === 'url');
    if (isNew && address !== undefined) {
      attempted = true;
      await focusProblem(address);
      return;
    }
    testing.mutate();
  }

  function leave(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }

  /** Moves to the delivery log, which holds the payload each delivery sent. */
  function jumpToLog(event: MouseEvent): void {
    event.preventDefault();
    const log = document.getElementById(LOG_ID);
    log?.scrollIntoView?.({ block: 'start' });
    log?.focus({ preventScroll: true });
  }
</script>

{#if unavailable}
  <HooksUnavailable />
{:else if notFound}
  <NotFoundState title={copy.notFound.title} description={copy.notFound.description} view="hooks" />
{:else}
  <section
    class="ib-hook-editor"
    aria-label={isNew ? copy.newTitle : title === '' ? copy.loadingLabel : title}
    data-page="hook-editor"
  >
    {#if isNew}
      <PageHeader title={copy.newTitle} description={copy.newDescription} headingLevel={1} />
    {:else if hook !== undefined}
      <HookEditorHeader
        {hook}
        {title}
        sentence={savedSentence}
        {latest}
        togglePending={switching.isPending}
        onToggle={toggle}
        onDelete={() => (confirmingDelete = true)}
        onJumpToLog={jumpToLog}
      />
    {/if}

    {#if !isNew && existing.isError}
      <Alert variant="danger">{copy.loadFailed}</Alert>
    {:else if stopped}
      <ErrorState
        bordered
        tone="neutral"
        title={copy.stopped.title}
        description={copy.stopped.description}
        headingLevel={2}
        retryLabel={RETRY_LABEL}
        retryVariant="secondary"
        onRetry={readAgain}
      />
    {:else if loading}
      <div data-testid="hook-loading">
        <Skeleton
          delay={LOADING_DELAY_MILLISECONDS}
          stillLoadingAfter={STILL_LOADING_MILLISECONDS}
          stillLoadingLabel={copy.stillLoading}
          label={copy.loadingLabel}
          onCancel={stopLoading}
        >
          <div class="ib-hook-editor__placeholder">
            <Skeleton height="1.75rem" width="55%" />
            <Skeleton variant="form" rows={2} />
            <Skeleton variant="form" rows={2} />
            <Skeleton variant="form" rows={2} />
          </div>
        </Skeleton>
      </div>
    {:else}
      <div class="ib-hook-editor__layout" class:ib-hook-editor__layout--single={isNew}>
        <form class="ib-hook-editor__steps" onsubmit={submit} novalidate>
          <section class="ib-hook-step" aria-labelledby="ib-hook-step-when">
            <h2 id="ib-hook-step-when" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.when.number}</span>
              {copy.steps.when.title}
            </h2>
            {#if compactWhen && hook !== undefined}
              <p class="ib-hook-step__summary" data-testid="hook-step-summary-when">
                <span>{whenSummary(hook, anyScopeOf(savedScopes))}</span>
                <Button variant="ghost" size="sm" onclick={() => (whenOpen = true)}
                  >{copy.steps.edit}</Button
                >
              </p>
            {:else}
              <HookEventPicker
                kinds={kinds.data ?? []}
                action={form.effectiveType}
                bind:events={form.events}
                locked={!isNew}
                error={problemOf('event')}
              />
              {#if kinds.isError}
                <Alert variant="danger">{copy.event.loadFailed}</Alert>
              {/if}
              <HookOnlyFor {form} kinds={kinds.data ?? []} error={problemOf('only-for')} />
              {#if scopeRefused}
                <Alert variant="warning" data-testid="hook-scope-refused"
                  >{copy.onlyFor.refused}</Alert
                >
              {/if}
              {#if refused.length > 0}
                <Alert variant="warning" data-testid="hook-refused-events">
                  {refused.map(eventWords).join(', ')}: {form.actionType === 'notify'
                    ? copy.event.notifyLoop
                    : copy.event.workflowLoop}
                </Alert>
              {/if}
            {/if}
          </section>

          <section class="ib-hook-step" aria-labelledby="ib-hook-step-then">
            <h2 id="ib-hook-step-then" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.what.number}</span>
              {copy.steps.what.title}
            </h2>
            {#if compactThen && hook !== undefined}
              <p class="ib-hook-step__summary" data-testid="hook-step-summary-then">
                <span>{thenSummary(hook.action)}</span>
                <Button variant="ghost" size="sm" onclick={() => (thenOpen = true)}
                  >{copy.steps.edit}</Button
                >
              </p>
            {:else if isPlugin && hook !== undefined}
              <p class="ib-hook-editor__plain">{copy.action.plugin}</p>
            {:else}
              {#if contributedKinds.length > 0}
                <Select
                  id="ib-hook-action"
                  label={copy.action.label}
                  description={isNew
                    ? remote
                      ? copy.action.chooseRemote
                      : copy.action.choose
                    : copy.action.fixed}
                  disabled={!isNew}
                  options={actionOptions}
                  value={actionValue}
                  onchange={(event) => chooseAction(event.currentTarget.value)}
                />
              {:else}
                <SegmentedControl
                  id="ib-hook-action"
                  label={copy.action.label}
                  {...hiddenLabel}
                  value={form.actionType}
                  disabled={!isNew}
                  onValueChange={(next: HookActionType) => chooseAction(next)}
                >
                  {#each HOOK_ACTION_TYPES as type (type)}
                    <Segment value={type} disabled={remote && type === 'webhook'}
                      >{actionLabel(type)}</Segment
                    >
                  {/each}
                </SegmentedControl>
                <p class="ib-hook-editor__plain">
                  {isNew
                    ? remote
                      ? copy.action.chooseRemote
                      : copy.action.choose
                    : copy.action.fixed}
                </p>
              {/if}
              {#if form.contributedKind !== null}
                <div class="ib-hook-editor__contributed" data-testid="contributed-action">
                  {#if chosenKind !== undefined}
                    <p class="ib-hook-editor__plain">{chosenKind.description}</p>
                    <ContributedConfigurationForm
                      kindId={hookActionKindId(chosenKind)}
                      schema={chosenKind.configuration}
                      value={form.contributedConfiguration}
                      onChange={(next) => (form.contributedConfiguration = next)}
                    />
                  {/if}
                </div>
              {:else if form.actionType === 'webhook'}
                <Input
                  id="ib-hook-url"
                  type="url"
                  variant="code"
                  label={copy.webhook.urlLabel}
                  placeholder={copy.webhook.urlPlaceholder}
                  required
                  {...urlError === undefined ? {} : { error: urlError }}
                  autocomplete="off"
                  bind:value={form.url}
                />
                {#if !isNew && hook !== undefined}
                  <HookSecretField
                    secret={revealedSecret}
                    replacing={replacing.isPending}
                    failure={secretFailure}
                    onReplace={() => replacing.mutate(hook)}
                    onSeePayload={jumpToLog}
                  />
                {/if}
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
                    description={form.workflowInput === 'event'
                      ? copy.workflow.payloadEvent
                      : copy.workflow.payload}
                    required
                    {...workflowError === undefined ? {} : { error: workflowError }}
                    disabled={workflows.isPending}
                    options={workflowOptions}
                    value={form.workflowId}
                    onchange={(event) => (form.workflowId = event.currentTarget.value)}
                  />
                  {#if chosenWorkflowDescription !== undefined && chosenWorkflowDescription !== ''}
                    <p class="ib-hook-editor__plain" data-testid="hook-workflow-description">
                      {chosenWorkflowDescription}
                    </p>
                  {/if}
                {/if}
              {:else}
                <p class="ib-hook-editor__plain" data-testid="hook-notify-note">
                  {copy.action.notifyNote}
                </p>
              {/if}
            {/if}
          </section>

          <section class="ib-hook-step" aria-labelledby="ib-hook-step-check">
            <h2 id="ib-hook-step-check" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.check.number}</span>
              {copy.steps.check.title}
            </h2>
            <Input
              id="ib-hook-name"
              label={copy.check.nameLabel}
              description={copy.check.nameDescription}
              {...nameError === undefined ? {} : { error: nameError }}
              bind:value={form.name}
            />
            {#if isNew && form.events.length === 0}
              <p class="ib-hook-editor__quiet" data-testid="hook-check-summary">
                {copy.check.pickEvent}
              </p>
            {:else if isNew}
              <div class="ib-hook-editor__quiet" data-testid="hook-check-summary">
                <p class="ib-hook-editor__quiet-line">
                  <span class="ib-hook-editor__sentence-label">{copy.check.eventLine}</span>
                  {#each form.events as kind (kind)}
                    <span>{eventOptionLabel(kind)} <code>{kind}</code></span>
                  {/each}
                </p>
                <p class="ib-hook-editor__quiet-line">{copy.check.saveToStart}</p>
              </div>
            {:else}
              <p class="ib-hook-editor__quiet" data-testid="hook-sentence">{draftSentence}</p>
            {/if}
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
              <Button type="submit" variant="primary" disabled={saving.isPending}
                >{isNew ? copy.check.create : copy.check.save}</Button
              >
              <Button
                data-changes
                variant="secondary"
                disabled={!canTest}
                onclick={() => void sendTest()}
              >
                {#snippet leadingIcon()}<Play aria-hidden="true" />{/snippet}
                {copy.check.test}
              </Button>
            </div>
            {#if testResult !== null}
              <Alert variant={testResult.ok ? 'success' : 'danger'} data-testid="hook-test-result">
                {testResult.text}
                {#if testResult.ok && !isNew}
                  <Link href={`#${LOG_ID}`} onclick={jumpToLog}>{copy.webhook.seePayload}</Link>
                {/if}
              </Alert>
            {/if}
            {#if testHint !== undefined}
              <p class="ib-hook-editor__hint">{testHint}</p>
            {/if}
          </section>
        </form>
        <aside id={LOG_ID} class="ib-hook-editor__aside" tabindex="-1">
          <HookDeliveries hookId={isNew ? undefined : hookId} />
        </aside>
      </div>
    {/if}
  </section>
{/if}

<ConfirmDialog
  bind:open={confirmingDelete}
  title={copy.check.deleteTitle(title)}
  description={copy.check.deleteDescription}
  confirmLabel={copy.check.deleteConfirm}
  destructive
  onConfirm={() => deletion.mutate()}
>
  {#snippet confirmIcon()}<Trash2 aria-hidden="true" />{/snippet}
</ConfirmDialog>

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

  /*
   * A side rail stacks below the main column under 1024px (design row 04b). A new hook is a form at
   * reading width (sweep S56), so its empty log stays below the steps instead of beside them.
   */
  @media (min-width: 64rem) {
    .ib-hook-editor__layout:not(.ib-hook-editor__layout--single):has(.ib-hook-editor__aside) {
      grid-template-columns: minmax(0, 3fr) minmax(0, 2fr);
    }
  }

  .ib-hook-editor__placeholder {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
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

  /* A phone's summary of a step: one line that opens to the step's fields. */
  .ib-hook-step__summary {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    margin: 0;
    overflow-wrap: anywhere;
  }

  /* The hook as a sentence, in a quiet box: Save hook and Send a test event sit directly under it. */
  .ib-hook-editor__quiet {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    padding: var(--cinder-space-3);
    border-radius: var(--cinder-radius-md);
    background: var(--cinder-surface-inset);
    overflow-wrap: anywhere;
  }

  .ib-hook-editor__quiet-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1) var(--cinder-space-3);
    margin: 0;
  }

  .ib-hook-editor__sentence-label {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .ib-hook-editor__contributed {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .ib-hook-editor__plain,
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
    scroll-margin-top: var(--cinder-space-4);
  }
</style>

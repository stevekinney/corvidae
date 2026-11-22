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
   * nothing. A saved hook that runs a plugin's action can be tested too when the action offers a
   * test: the action checks the event without doing what it does, so nothing is sent. A start-
   * workflow or notify hook cannot, because the Bureau refuses them (a test would start a real
   * workflow or write a real notification). When Send a test event is off, one sentence under it
   * says why, and the button names it with `aria-describedby`; the button stays focusable.
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
    Callout,
    ConfirmDialog,
    EmptyState,
    ErrorState,
    FormActions,
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
  import { RETRY_LABEL, STALE_COPY } from '../../app/copy/views.ts';
  import NotFoundState from '../../app/not-found-state.svelte';
  import { showFault, showToast } from '../../app/toast-host.svelte';
  import { agentFaultOf } from '../../lib/agent-definitions.ts';
  import {
    createHook,
    deleteHook,
    duplicateHook,
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
  import { classifyFault, faultErrorStateAdvice, faultTreatment } from '../../lib/faults.ts';
  import { getHostPaths } from '../../lib/host-paths.ts';
  import { getPlugins } from '../../lib/host-plugins.ts';
  import { hookPath } from '../../lib/identifier-paths.ts';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { routerSelectionLocationFor } from '../../lib/router-selection-location.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { listWorkflowFiles } from '../../lib/workflow-files.ts';
  import SecretDialog, { type SecretTarget } from '../settings/plugins/secret-dialog.svelte';
  import HookConfiguration from './hook-configuration.svelte';
  import { HOOKS_COPY } from './hook-copy.ts';
  import HookEditorHeader from './hook-editor-header.svelte';
  import {
    anyScopeOf,
    editorSentence,
    editorTitle,
    hookWriteReason,
    latestDelivery,
    configurationIssuesOf,
    isNeedsSetupRefusal,
    pluginTestOutcome,
    storedConfigurationSchema,
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
  import { actionTitleOf, hookStanding, pluginTitleOf } from './hook-standing.ts';
  import HookMissingEvents from './hook-missing-events.svelte';
  import {
    eventRefusal,
    eventsChosenLine,
    eventWords,
    isScopeKind,
    missingEventsOf,
    pluginEventOf,
    scopeKindsFor,
  } from './hook-presentation.ts';
  import HookSecretField from './hook-secret-field.svelte';
  import { holdSecret, peekHeldSecret, takeHeldSecret } from './hook-secret-once.ts';
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
   * same way. Leaving the page forgets it. It is read here and taken once the hook has been drawn,
   * because the outlet draws a page once more while the address changes, and the first drawing is
   * thrown away.
   */
  // svelte-ignore state_referenced_locally
  let revealedSecret = $state<string | null>(isNew ? null : (peekHeldSecret(hookId) ?? null));

  const existing = createQuery(
    () => ({
      queryKey: queryKeys.hooks.detail(hookId),
      queryFn: ({ signal }: { signal: AbortSignal }) => getHook(hookId, { signal }),
      enabled: !isNew,
      retry: false,
    }),
    undefined,
  );
  /**
   * The list of hooks. A home that keeps hooks off answers it as it answers every hook call, so the
   * new-hook page asks it for that; a saved hook reads its own `problems` from it (COR-2182), which
   * `bureau.hooks.get` does not carry, so its header says what its list row says.
   */
  const availability = createQuery(
    () => ({
      queryKey: queryKeys.hooks.list(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listHooks(undefined, { signal }),
      retry: false,
    }),
    undefined,
  );
  /** The problems the Bureau lists for this hook, or none until the list is read. */
  const listedProblems = $derived(
    availability.data?.find((listed) => listed.id === hookId)?.problems ?? [],
  );
  /** The plugin kinds this hook lists that are missing, which its When step says (COR-2226, row R5). */
  const missingEvents = $derived(isNew ? [] : missingEventsOf(listedProblems));
  /**
   * Whether the Bureau lists this hook's reaction as not registered (COR-2182, R10-17). Its header
   * says it can't run, so the page treats the action as not offered, whatever the contributions
   * list: no live form, and no test.
   */
  const reactionUnavailable = $derived(
    listedProblems.some((problem) => problem.code === 'reaction-unavailable'),
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
   * kind of action is fixed once a hook is made; a saved plugin hook reads it for whether its kind
   * has a dry run, which decides whether it can be tested (COR-2183).
   */
  const contributed = createQuery(
    () => ({
      queryKey: queryKeys.pluginKinds(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listContributedKinds({ signal }),
      enabled: isNew || existing.data?.action.type === 'plugin',
      retry: false,
    }),
    undefined,
  );
  /**
   * The plugins the host loaded (COR-2181): the title of the plugin a saved plugin hook runs, whether
   * it is disabled, and which of its secrets are saved. A new hook reads it only for the titles its
   * action choices are grouped by. A host that cannot say leaves each of those unknown, and nothing
   * is guessed from what is not known. A saved hook that lists a plugin's event kind reads it for
   * that plugin's title too (COR-2226).
   */
  const plugins = createQuery(
    () => ({
      queryKey: queryKeys.hostPlugins(),
      queryFn: ({ signal }: { signal: AbortSignal }) => getPlugins({ signal }),
      enabled:
        isNew ||
        existing.data?.action.type === 'plugin' ||
        (existing.data?.events.some((entry) => pluginEventOf(entry) !== undefined) ?? false),
      retry: false,
    }),
    undefined,
  );
  /** A plugin's title by its name, its name in words until the plugins are read (COR-2226). */
  const titleOfPlugin = (plugin: string): string => pluginTitleOf(plugin, plugins.data?.plugins);
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
  // The secret shown with a hook that was just made is shown once: the page that drew it forgets it.
  $effect(() => {
    if (hook !== undefined) takeHeldSecret(hookId);
  });

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
  /**
   * Counts the revisions of the hook the form adopted. The configuration form takes its value only
   * when it is made, so it is made again under this key whenever a revision is adopted (a refresh,
   * Reload, or this page's own save), and never on an edit of the draft.
   */
  let adoptions = $state(0);
  /** Fills the form from `adopted`, the revision of the hook it now edits. */
  function loadRevision(adopted: Hook): void {
    loadedRevision = adopted.revision;
    form.load(adopted);
    adoptions += 1;
    changed = false;
  }
  $effect(() => {
    const current = hook;
    if (current === undefined) return;
    untrack(() => {
      if (current.revision === loadedRevision) return;
      if (loadedRevision !== -1 && form.dirty && current.revision !== savedRevision) {
        changed = true;
        return;
      }
      loadRevision(current);
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
      loadRevision(fresh);
      stale = false;
      failure = null;
    } catch (error) {
      failure = `${copy.loadFailed} ${faultTreatment(error).message}`;
    }
  }

  const isPlugin = $derived(hook?.action.type === 'plugin');
  /** A default hook: one a plugin declared. The owner turns it on or off and copies it, and changes nothing else. */
  const declared = $derived(hook?.declaredBy ?? null);
  const isDefault = $derived(declared !== null);
  /** Where the hook stands: the one status its header and its list row say (COR-2181). */
  const standing = $derived(
    hook === undefined
      ? undefined
      : hookStanding(
          { ...hook, problems: listedProblems },
          {
            plugins: plugins.data?.plugins,
            reactions: contributed.isSuccess ? contributed.data.reactions : undefined,
          },
        ),
  );
  /** The title of the plugin a default hook came from, for the note above its steps. */
  const declaringTitle = $derived(
    declared === null ? undefined : pluginTitleOf(declared.plugin, plugins.data?.plugins),
  );
  /** Settings › Plugins, which opens the plugin its address selects. */
  const pluginSettings = routerSelectionLocationFor('/settings/plugins');
  /** The key the header's Add the key dialog is for, or `null` while it is closed. */
  let addingKey = $state<SecretTarget | null>(null);
  /** The kinds of subject the chosen events narrow by, which say what "any" covers in the sentence. */
  const allowedScopes = $derived(scopeKindsFor(form.events, kinds.data ?? []));
  const draftSentence = $derived(
    editorSentence(
      isPlugin && hook !== undefined
        ? { events: form.events, action: hook.action, scope: form.draftScope }
        : { events: form.events, action: form.draftAction, scope: form.draftScope },
      anyScopeOf(allowedScopes),
      titleOfPlugin,
    ),
  );
  /** The hook as it is saved, which the header says: it is not what is typed and not yet saved. */
  const savedScopes = $derived(scopeKindsFor(hook?.events ?? [], kinds.data ?? []));
  const savedSentence = $derived(
    hook === undefined ? '' : editorSentence(hook, anyScopeOf(savedScopes), titleOfPlugin),
  );
  const title = $derived(
    isNew
      ? copy.newTitle
      : hook === undefined
        ? ''
        : editorTitle(hook, anyScopeOf(savedScopes), titleOfPlugin),
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
  /** The choices under Then: the built-in actions, and "Run an action from a plugin" once a plugin offers one. */
  const actionChoices = $derived([
    ...HOOK_ACTION_TYPES.map((type) => ({
      value: type as HookActionType | 'plugin',
      label: actionLabel(type),
      disabled: remote && type === 'webhook',
    })),
    ...(contributedKinds.length === 0
      ? []
      : [{ value: 'plugin' as const, label: copy.action.plugin, disabled: false }]),
  ]);
  /** The plugin's actions, grouped by the plugin's title; one whose plugin needs setup can still be chosen. */
  const pluginActionOptions = $derived(
    contributedKinds.map((kind) => ({
      value: hookActionKindId(kind),
      label: actionTitleOf(kind.kind),
      group: pluginTitleOf(kind.plugin, plugins.data?.plugins),
      ...(kind.availability === 'needs-setup' ? { note: copy.action.needsSetup } : {}),
    })),
  );
  /** The contributed kind the form has chosen, with its description and configuration schema. */
  const chosenKind = $derived(
    form.contributedKind === null
      ? undefined
      : contributedKinds.find(
          (kind) =>
            kind.plugin === form.contributedKind?.plugin && kind.kind === form.contributedKind.kind,
        ),
  );
  /** What the choice under Then shows: a built-in action, or `plugin` while the action is one a plugin offers. */
  const actionValue = $derived(form.effectiveType);

  function chooseAction(value: HookActionType | 'plugin'): void {
    form.contributedKind = null;
    form.contributedConfiguration = {};
    if (value === 'plugin') {
      form.choosePlugin = true;
      return;
    }
    form.choosePlugin = false;
    form.actionType = value;
  }

  /** Chooses which of a plugin's actions a new hook runs, which starts its configuration empty. */
  function choosePluginAction(id: string): void {
    const kind = contributedKinds.find((candidate) => hookActionKindId(candidate) === id);
    if (kind === undefined) return;
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
  const FIELD_ORDER: readonly HookProblemField[] = [
    'event',
    'only-for',
    'action',
    'url',
    'workflow',
    'name',
  ];
  /** The control each field's problem moves focus to. */
  const FIELD_IDS: Readonly<Record<HookProblemField, string>> = {
    event: 'ib-hook-event',
    'only-for': 'ib-hook-only-for',
    action: 'ib-hook-plugin-action',
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
  const pluginActionError = $derived(problemOf('action'));
  /** A workflow that was deleted is said at once, beside the old name the field keeps. */
  const workflowError = $derived(workflowDeleted ? copy.workflow.deleted : problemOf('workflow'));
  const nameError = $derived(problemOf('name'));

  /** On a phone the When and Then steps of a saved hook are summaries until they are opened. */
  let whenOpen = $state(false);
  let thenOpen = $state(false);
  // A default hook has nothing to open: its steps are text, with no Edit button (COR-2181).
  const compactWhen = $derived(phoneViewport.current && !isNew && !isDefault && !whenOpen);
  // A plugin hook's Then is its configuration, the page's reason for being, so it is never folded.
  const compactThen = $derived(
    phoneViewport.current && !isNew && !isDefault && hook?.action.type !== 'plugin' && !thenOpen,
  );

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
  /** What the Bureau refused at a field of the plugin action's configuration, shown on that field. */
  let configurationIssues = $state<{ path: readonly string[]; message: string }[]>([]);
  /**
   * The fields the Bureau lists as no longer fitting the action's schema (COR-2182), marked on the
   * form as a refused save marks them, until a save says what it refused. Editing a field clears
   * its mark.
   */
  const listedConfigurationIssues = $derived.by(() => {
    if (hook?.action.type !== 'plugin') return [];
    const message = HOOKS_COPY.editor.action.configurationIssue(
      pluginTitleOf(hook.action.plugin, plugins.data?.plugins),
    );
    return listedProblems.flatMap((problem) =>
      problem.code === 'configuration-invalid'
        ? problem.issues.map((issue) => ({ path: issue.path, message }))
        : [],
    );
  });
  const shownConfigurationIssues = $derived(
    configurationIssues.length > 0 ? configurationIssues : listedConfigurationIssues,
  );
  let stale = $state(false);

  const saving = createMutation(() => ({
    mutationFn: async (): Promise<Hook & { signingSecret?: string | null }> =>
      isNew || hook === undefined
        ? createHook(form.toInput())
        : updateHook(hook.id, loadedRevision, form.toChange(hook)),
    onMutate: () => {
      failure = null;
      configurationIssues = [];
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
      configurationIssues = configurationIssuesOf(error);
      failure = `${copy.saveFailed} ${hookWriteReason(error)} ${copy.saveFailedKept}`;
    },
  }));

  /** Makes an off copy the owner can change from a default hook, and opens it. */
  const duplicating = createMutation(() => ({
    mutationFn: (source: Hook) =>
      duplicateHook(source.id, HOOKS_COPY.defaultHook.copyName(source.name ?? title).slice(0, 100)),
    onSuccess: async (duplicate) => {
      await queryClient.invalidateQueries({ queryKey: ['hooks'] });
      router.navigate(hookPath(duplicate.id));
      showToast(HOOKS_COPY.defaultHook.duplicated);
    },
    onError: (error: unknown) => {
      const treatment = faultTreatment(error);
      showFault({
        ...treatment,
        message: `${HOOKS_COPY.defaultHook.duplicateFailed}. ${treatment.message}`,
      });
    },
  }));

  /** Opens the dialog that saves the one secret a plugin lacks, from the header's Add the key. */
  function addKey(plugin: string, key: string): void {
    addingKey = { plugin, key };
  }

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
      const name = editorTitle(
        saved,
        anyScopeOf(scopeKindsFor(saved.events, kinds.data ?? [])),
        titleOfPlugin,
      );
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
      if (hook.action.type === 'plugin') {
        const { plugin, kind } = hook.action;
        try {
          return pluginTestOutcome(await testHook(hook.id), plugin, kind);
        } catch (error) {
          // The listing does not say a plugin needs setup, so the Bureau's refusal does: it is said
          // in the editor's words, and as a wait, not a failure.
          if (isNeedsSetupRefusal(error)) {
            return {
              tone: 'warning',
              text: copy.check.testPluginNeedsSetup(pluginTitleOf(plugin, plugins.data?.plugins)),
            };
          }
          throw error;
        }
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
      testResult = { tone: 'danger', text: `${copy.check.testFailed} ${hookWriteReason(error)}` };
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
  /**
   * The contributed kind a saved plugin hook runs, as the Bureau lists it now; `undefined` for any
   * other hook, and for a plugin hook whose kind is not listed (its plugin is off).
   */
  const savedKind = $derived(
    hook?.action.type === 'plugin' && !reactionUnavailable
      ? contributedKinds.find(
          (kind) =>
            hook.action.type === 'plugin' &&
            kind.plugin === hook.action.plugin &&
            kind.kind === hook.action.kind,
        )
      : undefined,
  );
  /**
   * The saved configuration of a plugin hook as a schema of read-only pairs, for when its action
   * is not offered now and its own schema is unknown (row R10-08); `null` when there is nothing.
   */
  const storedSchema = $derived(
    hook?.action.type === 'plugin' ? storedConfigurationSchema(hook.action.configuration) : null,
  );
  /**
   * Why Send a test event is off, in one sentence for each cause, or `undefined` when nothing is
   * said: it is on, or the answer that decides it has not come yet. A hook that is not saved can
   * send a webhook test and nothing else.
   */
  const testReason = $derived.by((): string | undefined => {
    if (isNew) {
      if (form.effectiveType === 'webhook') return undefined;
      if (form.contributedKind === null && !form.choosePlugin) return copy.check.testWebhookOnly;
      if (form.contributedKind === null) return undefined;
      if (chosenKind === undefined) return undefined;
      return chosenKind.dryRun ? copy.check.testSaveFirst : copy.check.testNotOffered;
    }
    if (hook === undefined || hook.action.type === 'webhook') return undefined;
    if (hook.action.type !== 'plugin') return copy.check.testWebhookOnly;
    // The Bureau lists the kinds a running plugin contributes: one that is not listed is off.
    if (contributed.isPending) return undefined;
    if (contributed.isError) return copy.check.testPluginUnknown;
    const pluginTitle = pluginTitleOf(hook.action.plugin, plugins.data?.plugins);
    if (savedKind === undefined) {
      // A plugin that is on and no longer offers the action needs its own sentence: "turn it on" is wrong for it.
      return testReasonKind === 'not-offered'
        ? copy.check.testNoLongerOffered(pluginTitle)
        : copy.check.testPluginOff(pluginTitle);
    }
    // Read from what the action says of itself (COR-2181), so the button is off before it is pressed.
    if (savedKind.availability === 'needs-setup')
      return copy.check.testPluginNeedsSetup(pluginTitle);
    return savedKind.dryRun ? undefined : copy.check.testNotOffered;
  });
  /** Which of the two causes of an action that is not listed it is: its plugin is on and dropped it, or its plugin is off. */
  const testReasonKind = $derived.by((): 'plugin-off' | 'not-offered' => {
    if (hook?.action.type !== 'plugin') return 'plugin-off';
    const { plugin } = hook.action;
    const state = plugins.data?.plugins.find((candidate) => candidate.descriptor.name === plugin);
    // A reaction the Bureau lists as unavailable is not offered unless its plugin is off, as the
    // header's standing reads it.
    if (reactionUnavailable && state?.status !== 'disabled') return 'not-offered';
    // Only a plugin the host says is on can have dropped the action; anything else is "turn it on".
    return state?.status === 'running' || state?.status === 'needs-setup'
      ? 'not-offered'
      : 'plugin-off';
  });
  /** The reason in the parts the page draws it from, when "Settings" is a link: the plugin is off. */
  const testReasonParts = $derived.by(() => {
    if (
      hook?.action.type !== 'plugin' ||
      !contributed.isSuccess ||
      savedKind !== undefined ||
      testReasonKind !== 'plugin-off'
    ) {
      return undefined;
    }
    return {
      ...copy.check.testPluginOffParts(pluginTitleOf(hook.action.plugin, plugins.data?.plugins)),
      path: pluginSettings.pathTo('plugin', hook.action.plugin),
    };
  });
  /** Whether Send a test event can be pressed: a webhook sends one, and a saved plugin action that offers a test runs it. */
  const canTest = $derived(
    !testing.isPending &&
      testReason === undefined &&
      (isNew
        ? form.effectiveType === 'webhook'
        : webhookAddress !== undefined || savedKind?.dryRun === true),
  );
  const TEST_REASON_ID = 'ib-hook-test-reason';

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
    {:else if hook !== undefined && standing !== undefined}
      <HookEditorHeader
        {hook}
        {title}
        sentence={savedSentence}
        {latest}
        {standing}
        {declaringTitle}
        togglePending={switching.isPending}
        duplicating={duplicating.isPending}
        onToggle={toggle}
        onDelete={() => (confirmingDelete = true)}
        onDuplicate={() => duplicating.mutate(hook)}
        onAddKey={addKey}
        onJumpToLog={jumpToLog}
      />
    {/if}

    {#if !isNew && existing.isError}
      <ErrorState
        variant="row"
        bordered
        title={copy.loadFailed}
        description=""
        headingLevel={hook !== undefined && standing !== undefined ? 2 : 1}
        retryLabel={RETRY_LABEL}
        {...faultErrorStateAdvice(existing.error, readAgain)}
      />
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
          {#if isDefault && declared !== null && declaringTitle !== undefined}
            <!-- Said once: the plugin that added the hook, and what the owner can do with it. -->
            <Callout semantic="note" data-testid="hook-provenance">
              <Link
                underline="always"
                href={router.href(pluginSettings.pathTo('plugin', declared.plugin))}
                onclick={(event) => leave(event, pluginSettings.pathTo('plugin', declared.plugin))}
                >{declaringTitle}</Link
              >{declared.withdrawn
                ? HOOKS_COPY.defaultHook.provenance.withdrawn
                : HOOKS_COPY.defaultHook.provenance.untouched}
            </Callout>
          {/if}
          <section class="ib-hook-step" aria-labelledby="ib-hook-step-when">
            <h2 id="ib-hook-step-when" class="ib-hook-step__title">
              <span class="ib-hook-step__number" aria-hidden="true">{copy.steps.when.number}</span>
              {copy.steps.when.title}
            </h2>
            {#if compactWhen && hook !== undefined}
              <!-- A missing kind is said directly under the summary it qualifies, before Edit (N1). -->
              <div class="ib-hook-step__summary" data-testid="hook-step-summary-when">
                <div class="ib-hook-step__summary-text">
                  <p class="ib-hook-step__summary-line">
                    {whenSummary(hook, anyScopeOf(savedScopes), titleOfPlugin)}
                  </p>
                  <HookMissingEvents missing={missingEvents} titleOf={titleOfPlugin} />
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => (whenOpen = true)}
                  label={copy.steps.edit}
                />
              </div>
            {:else if isDefault && hook !== undefined}
              <p class="ib-hook-editor__plain" data-testid="hook-when-readonly">
                {whenSummary(hook, anyScopeOf(savedScopes), titleOfPlugin)}
              </p>
              <HookMissingEvents missing={missingEvents} titleOf={titleOfPlugin} />
            {:else}
              <HookEventPicker
                kinds={kinds.data ?? []}
                action={form.effectiveType}
                bind:events={form.events}
                locked={!isNew}
                error={problemOf('event')}
                titleOf={titleOfPlugin}
              />
              <HookMissingEvents missing={missingEvents} titleOf={titleOfPlugin} />
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
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => (thenOpen = true)}
                  label={copy.steps.edit}
                />
              </p>
            {:else if isPlugin && hook !== undefined && hook.action.type === 'plugin'}
              <!-- A saved plugin hook: its action is fixed and shown as text, and its configuration is
                   the form below (read only for a default hook, which the owner cannot change). -->
              <p class="ib-hook-editor__plain">{copy.action.plugin}</p>
              <p class="ib-hook-editor__plain" data-testid="hook-plugin-action">
                {copy.action.pluginFixed(
                  actionTitleOf(hook.action.kind),
                  pluginTitleOf(hook.action.plugin, plugins.data?.plugins),
                )}
              </p>
              {#if savedKind !== undefined}
                <div class="ib-hook-editor__contributed" data-testid="contributed-action">
                  <p class="ib-hook-editor__plain">{savedKind.description}</p>
                  {#key adoptions}
                    <HookConfiguration
                      kindId={hookActionKindId(savedKind)}
                      schema={savedKind.configuration}
                      value={form.contributedConfiguration}
                      readOnly={isDefault}
                      issues={shownConfigurationIssues}
                      disabled={saving.isPending}
                      plugin={hook.action.plugin}
                      reportInitialDraft={form.storedConfigurationDrawable}
                      onChange={(next) => {
                        form.contributedConfiguration = next;
                      }}
                    />
                  {/key}
                </div>
              {:else if contributed.isSuccess && storedSchema !== null}
                <!-- The action is not offered now, so its schema is unknown: the saved pairs are
                     shown as they are, read only, and nothing is lost or changed (row R10-08). The
                     pairs are made again for each revision of the hook, which they take at mount. -->
                <div class="ib-hook-editor__contributed" data-testid="stored-configuration">
                  <p class="ib-hook-editor__plain">{copy.action.storedConfiguration}</p>
                  {#key hook.revision}
                    <HookConfiguration
                      kindId={`stored:${hook.id}`}
                      schema={storedSchema}
                      value={hook.action.configuration}
                      readOnly
                      plugin={hook.action.plugin}
                    />
                  {/key}
                </div>
              {/if}
            {:else}
              <SegmentedControl
                id="ib-hook-action"
                label={copy.action.label}
                {...hiddenLabel}
                overflow="select"
                value={actionValue}
                disabled={!isNew}
                onValueChange={(next: HookActionType | 'plugin') => chooseAction(next)}
              >
                {#each actionChoices as choice (choice.value)}
                  <Segment value={choice.value} disabled={choice.disabled}>{choice.label}</Segment>
                {/each}
              </SegmentedControl>
              <p class="ib-hook-editor__plain">
                {isNew
                  ? remote
                    ? copy.action.chooseRemote
                    : copy.action.choose
                  : copy.action.fixed}
              </p>
              {#if form.choosePlugin}
                <Select
                  id="ib-hook-plugin-action"
                  presentation="listbox"
                  label={copy.action.pluginLabel}
                  placeholder={copy.action.pluginPlaceholder}
                  required
                  {...pluginActionError === undefined ? {} : { error: pluginActionError }}
                  options={pluginActionOptions}
                  {...form.contributedKind === null
                    ? {}
                    : { value: hookActionKindId(form.contributedKind) }}
                  onValueChange={choosePluginAction}
                />
              {/if}
              {#if form.contributedKind !== null}
                <div class="ib-hook-editor__contributed" data-testid="contributed-action">
                  {#if chosenKind !== undefined}
                    <p class="ib-hook-editor__plain">{chosenKind.description}</p>
                    <HookConfiguration
                      kindId={hookActionKindId(chosenKind)}
                      schema={chosenKind.configuration}
                      value={form.contributedConfiguration}
                      issues={configurationIssues}
                      disabled={saving.isPending}
                      plugin={chosenKind.plugin}
                      onChange={(next) => {
                        form.contributedConfiguration = next;
                      }}
                    />
                  {/if}
                </div>
              {:else if form.choosePlugin}
                <!-- The action is chosen above; its fields come with it. -->
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
                    actions={[
                      {
                        label: copy.workflow.create,
                        href: router.href('/workflows/new'),
                        onclick: (event) => leave(event, '/workflows/new'),
                      },
                    ]}
                  />
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
            {#if !isDefault}
              <Input
                id="ib-hook-name"
                label={copy.check.nameLabel}
                description={copy.check.nameDescription}
                {...nameError === undefined ? {} : { error: nameError }}
                bind:value={form.name}
              />
            {/if}
            {#if isNew && form.events.length === 0}
              <p class="ib-hook-editor__quiet" data-testid="hook-check-summary">
                {copy.check.pickEvent}
              </p>
            {:else if isNew}
              <div class="ib-hook-editor__quiet" data-testid="hook-check-summary">
                <p class="ib-hook-editor__quiet-line">
                  <span class="ib-hook-editor__sentence-label">{copy.check.eventLine}</span>
                  <!-- Row R10-23: the events in words, never their identifiers. -->
                  <span data-testid="hook-check-events"
                    >{eventsChosenLine(form.events, titleOfPlugin)}</span
                  >
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
                <Button
                  variant="secondary"
                  size="sm"
                  onclick={() => void reload()}
                  label={copy.reload}
                />
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
            <FormActions>
              {#snippet end()}
                {#if !isDefault}
                  <Button type="submit" variant="primary" disabled={saving.isPending}
                    >{isNew ? copy.check.create : copy.check.save}</Button
                  >
                {/if}
                <!-- Off is `aria-disabled`, not `disabled`: the button stays in the tab order, so the
                   reason below it can be read from the button itself, and Cinder ignores the press. -->
                <Button
                  data-changes
                  variant="secondary"
                  aria-disabled={canTest ? undefined : 'true'}
                  aria-describedby={testReason === undefined ? undefined : TEST_REASON_ID}
                  loading={testing.isPending}
                  onclick={() => void sendTest()}
                >
                  {#snippet leadingIcon()}<Play aria-hidden="true" />{/snippet}
                  {copy.check.test}
                </Button>
              {/snippet}
            </FormActions>
            {#if testResult !== null}
              <!-- The actions are passed only for a result with a link: Cinder draws its actions box
                   for any snippet, and an empty one wraps to a line of its own on a narrow phone. -->
              {@const link = isNew ? undefined : testResult.link}
              {#snippet resultLink()}
                <Link href={`#${LOG_ID}`} underline="always" onclick={jumpToLog}
                  >{link === 'payload' ? copy.webhook.seePayload : copy.header.jumpToLog}</Link
                >
              {/snippet}
              <Alert
                variant={testResult.tone}
                data-testid="hook-test-result"
                {...link === undefined ? {} : { actions: resultLink }}
              >
                {testResult.text}
              </Alert>
            {/if}
            {#if testReason !== undefined}
              <p class="ib-hook-editor__hint" id={TEST_REASON_ID} data-testid="hook-test-reason">
                {#if testReasonParts !== undefined}
                  {testReasonParts?.before}<Link
                    underline="always"
                    href={router.href(testReasonParts?.path ?? '')}
                    onclick={(event) => leave(event, testReasonParts?.path ?? '')}
                    >{testReasonParts?.link}</Link
                  >{testReasonParts?.after}
                {:else}
                  {testReason}
                {/if}
              </p>
            {/if}
          </section>
        </form>
        {#if !isNew}
          <aside id={LOG_ID} class="ib-hook-editor__aside" tabindex="-1">
            <HookDeliveries {hookId} events={hook?.events ?? []} />
          </aside>
        {/if}
      </div>
    {/if}
  </section>
{/if}

<SecretDialog bind:target={addingKey} />

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

  /* A phone's summary of a step: one line that opens to the step's fields. The text wraps in its
     own column and Edit never wraps under it, so every step's Edit sits at the top inline end (B6). */
  .ib-hook-step__summary {
    display: flex;
    flex-wrap: nowrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: var(--cinder-space-2);
    margin: 0;
    overflow-wrap: anywhere;
  }

  /* The When summary's text, with a missing kind's line directly under it and Edit after both. Its
     basis is 0, not its longest line, so a long title or a missing kind never pushes Edit down. */
  .ib-hook-step__summary-text {
    display: flex;
    flex: 1 1 0;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-inline-size: 0;
  }

  .ib-hook-step__summary-line {
    margin: 0;
  }

  /* The hook as a sentence, in plain muted text with no box: Save hook and Send a test event sit directly under it. */
  .ib-hook-editor__quiet {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-1);
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
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

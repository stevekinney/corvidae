<script lang="ts">
  /**
   * `/workflows/:workflow`: one workflow type, in four tabs. The header says whether it is healthy
   * at a glance: its title with its identifier, a status only when it is paused or cannot load,
   * what it is for, what starts it, when it last ran and how that ended, and its file and schedule.
   * Overview leads with its steps (for a file) and its input and output. Code is the file's source,
   * or, for a type code defined, the description and contract it registered. Runs is its newest
   * runs and a link to all of them, with their number after the label. History is the versions that
   * have run, each with whether it is compatible with the current one; a type the Bureau registers
   * for itself has neither Code nor History, and says so on its Overview. The header holds start
   * run, which opens the run setup page and which every type but the Bureau's own has, or Resume in
   * its place for a paused file; Edit, which only a file has; and a "⋯" menu (board PageWorkflow,
   * "More menu, and Delete"), whose Send a signal opens a dialog, and which holds a file's
   * Duplicate, Pause (while it runs) and Delete…, which opens the delete dialog. Delete asks first,
   * names the schedules that run the workflow from outside its file, and offers to delete them too.
   * Its title, tabs and actions come from the route, so they show while the type is still loading.
   *
   * A write names the hash of the file the page read, so a file that changed on disk since is
   * refused instead of overwritten: the page says the workflow changed outside Interborough, with a
   * reload, and changes nothing. A write that succeeds takes the file's new hash at once, so the
   * next action is not stale against the page's own write. A file that is gone is the frame's
   * not-found state, so the page asks the frame to look again. An invalid file shows a banner with
   * its problem and the way to it, offers delete and edit (which opens the JSON), and has no
   * schemas; Start run is off, and says why in the banner.
   *
   * The page draws the connection banner itself, under its header, and leaves Edit, Start run and
   * Resume marked `data-changes`, so the shell turns them off while the server does not answer.
   */
  import {
    Alert,
    Banner,
    Button,
    PageHeader,
    Skeleton,
    StatusDot,
    Tabs,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';
  import { untrack } from 'svelte';

  import {
    CONNECTION_MAX_ATTEMPTS,
    connectionBannerPreset,
    getConnection,
  } from '../../app/connection.svelte.ts';
  import { usePageLabel } from '../../app/breadcrumbs.svelte.ts';
  import { RETRY_LABEL, WORKFLOW_COPY } from '../../app/copy.ts';
  import { restartActivity } from '../../app/restart/host-restart-flow.svelte.ts';
  import { showToast } from '../../app/toast-host.svelte';
  import { agentFaultOf, type AgentFault } from '../../lib/agent-definitions.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { getClient } from '../../lib/client.ts';
  import { getHostPaths, workflowFilePath } from '../../lib/host-paths.ts';
  import { queryKeys, workflowViewInstance } from '../../lib/query.ts';
  import { router, scheduleDetailPath, workflowRunPath } from '../../lib/router.svelte.ts';
  import {
    availableActions,
    awaitedSignals,
    isEngineType,
    resolveWorkflow,
    startingSchedules,
    type WorkflowResolution,
  } from '../../lib/workflow-catalog.ts';
  import {
    internalWorkflowsPath,
    workflowEditJsonPath,
    workflowEditPath,
    workflowRunSetupPath,
    workflowTypePath,
  } from '../../lib/workflow-type-paths.ts';
  import {
    deleteWorkflowFile,
    getLatestSavedSteps,
    isApplyFailure,
    listWorkflowFileRuns,
    listWorkflowRevisions,
    parseWorkflowText,
    pauseWorkflowFile,
    resumeWorkflowFile,
  } from '../../lib/workflow-files.ts';
  import { cancelSchedule } from '../schedules/schedule-queries.ts';
  import WorkflowRevisionsPanel from '../system/workflow-revisions-panel.svelte';
  import DeleteWorkflowDialog, { type DeleteDialogSchedule } from './delete-workflow-dialog.svelte';
  import RecentRuns from './recent-runs.svelte';
  import RevisionHistory from './revision-history.svelte';
  import SignalForm from './signal-form.svelte';
  import WorkflowCode from './workflow-code.svelte';
  import WorkflowFileProblem from './workflow-file-problem.svelte';
  import WorkflowHeaderLine from './workflow-header-line.svelte';
  import WorkflowMoreMenu from './workflow-more-menu.svelte';
  import WorkflowOverview from './workflow-overview.svelte';
  import {
    builtInLine,
    lastRunLine,
    scheduleLine,
    startsLine,
    type HeaderLine,
    type HeaderSchedule,
    type LastRun,
    type WorkflowStepSource,
  } from './workflow-page-presentation.ts';
  import {
    definitionDetails,
    type DefinitionDetails,
    internalWords,
    scheduleLabel,
    schedulesSummary,
    schemaOf,
    triggerSummary,
  } from './workflow-presentation.ts';
  import { DuplicateRefused, duplicateWorkflowFile } from './workflow-duplicate.ts';
  import { locateJsonProblem } from './workflow-source.ts';

  const copy = WORKFLOW_COPY;
  const client = getClient();
  const queryClient = useQueryClient();
  const connection = getConnection();
  /** How many of a file's newest runs the header reads: as many as the Runs tab lists. */
  const HEADLINE_LIMIT = 20;
  /** What an internal workflow's Overview shows of its contract: nothing, it says what it is instead. */
  const NO_DETAILS: DefinitionDetails = { signals: [], updates: [], queries: [] };

  // The page draws the connection banner under its own header, so the shell leaves it to the page.
  $effect(() => connection.claimBanner());

  // One page belongs to one type: the outlet mounts a new page when the path changes.
  const type = untrack(() => router.current.params['workflow'] ?? '');
  const detailKey = queryKeys.workflowCatalog.detail(type);

  const resolution = createQuery(
    () => ({
      queryKey: detailKey,
      queryFn: async ({ signal }) => (await resolveWorkflow(client, type, { signal })) ?? null,
    }),
    undefined,
  );

  const schedules = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.schedules(type),
      queryFn: async () => {
        const page = await client.listSchedules({ workflowType: type });
        return startingSchedules(page.items);
      },
    }),
    undefined,
  );

  // Where the file is. A host that does not say shows the path relative to the state directory.
  const hostPaths = createQuery(
    () => ({ queryKey: queryKeys.hostPaths(), queryFn: ({ signal }) => getHostPaths({ signal }) }),
    undefined,
  );

  // How many runs the type has and its newest, for the header's last-run line and the Runs tab's
  // count. A file's runs are the Bureau's (the console's engine may not hold them), and it counts
  // the newest twenty, as the Runs tab lists them; a code type's are the engine's, with its total.
  const headline = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.headline(type),
      queryFn: async ({
        signal,
      }): Promise<{ readonly total: number; readonly newest: LastRun | null }> => {
        if (resolution.data?.kind === 'agent-authored') {
          const runs = await listWorkflowFileRuns(type, HEADLINE_LIMIT, { signal });
          const [newest] = runs;
          return {
            total: runs.length,
            newest:
              newest === undefined
                ? null
                : {
                    id: newest.id,
                    status: newest.status,
                    createdAt: Date.parse(newest.createdAt),
                  },
          };
        }
        const page = await client.list({ type, limit: 1 });
        const [newest] = page.items;
        return {
          total: page.total,
          newest:
            newest === undefined
              ? null
              : { id: newest.id, status: newest.status, createdAt: newest.createdAt },
        };
      },
      enabled: resolution.data !== undefined && resolution.data !== null,
      retry: false,
    }),
    undefined,
  );

  // The versions that have run, for the History tab's count. The tab reads the same key, so the
  // list is asked for once.
  const revisions = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.revisions(type),
      queryFn: ({ signal }) => listWorkflowRevisions(type, { signal }),
      enabled: resolution.data?.kind === 'agent-authored',
      retry: false,
    }),
    undefined,
  );

  const resolved = $derived(resolution.data ?? undefined);
  const file = $derived(resolved?.kind === 'agent-authored' ? resolved.file : undefined);
  const document = $derived(file === undefined ? undefined : parseWorkflowText(file.text));
  const actions = $derived(file === undefined ? undefined : availableActions(file));
  const path = $derived(
    file === undefined
      ? ''
      : workflowFilePath(hostPaths.data?.workflowDirectory ?? copy.fallbackDirectory, file.id),
  );

  /** A write was refused because the file changed on disk after the page loaded. */
  let stale = $state(false);
  /** A write failed for a reason the person can act on, in the Bureau's words. */
  let failure = $state<{ readonly title: string; readonly message: string } | null>(null);
  let confirmingDelete = $state(false);
  /** Why the delete the dialog asked for failed, shown in the dialog until it is asked again. */
  let deleteError = $state<string | undefined>(undefined);
  /** The Bureau changed the file and the engine could not follow, so what is on disk is the change. */
  let unapplied = $state(false);

  /** A file that is gone, or never was: the frame owns that state, so it is asked to look again. */
  function workflowIsGone(): void {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.view('workflows', workflowViewInstance('/workflows/:workflow', type)),
    });
  }

  function failWith(fault: AgentFault, title: string): void {
    switch (fault.kind) {
      case 'stale':
        // The page's picture of the file is out of date, so what it said about it no longer holds.
        unapplied = false;
        stale = true;
        return;
      case 'not-found':
        workflowIsGone();
        return;
      case 'forbidden':
        failure = { title, message: copy.forbidden };
        return;
      case 'identifier-taken':
        // Only a create names an identifier, and this page never creates.
        failure = { title, message: title };
        return;
      case 'rejected':
      case 'other':
        failure = { title, message: fault.message };
        return;
    }
  }

  /** Takes the file's new hash and paused flag at once, then reads the file again to confirm. */
  function adopt(result: { readonly hash: string }, paused: boolean): void {
    // The write went through and the engine followed it, so nothing is left unapplied.
    unapplied = false;
    queryClient.setQueryData<WorkflowResolution | null>(detailKey, (previous) =>
      previous?.kind === 'agent-authored'
        ? { ...previous, file: { ...previous.file, hash: result.hash, paused } }
        : previous,
    );
    void queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.schedules(type) });
  }

  /** The write reached the file: take what is on disk, and say the engine has not followed yet. */
  async function adoptWhatIsOnDisk(): Promise<void> {
    unapplied = true;
    await queryClient.invalidateQueries({ queryKey: detailKey });
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
  }

  /** Sorts a refused write: one the Bureau made and the engine could not apply is not a failure. */
  function writeFailed(error: unknown, title: string): void {
    if (isApplyFailure(error)) {
      void adoptWhatIsOnDisk();
      return;
    }
    failWith(agentFaultOf(error), title);
  }

  /** After a delete: the list of workflows, which no longer shows this one. */
  function leaveForTheList(): void {
    router.navigate('/workflows');
    void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
  }

  const pause = createMutation(() => ({
    mutationFn: (hash: string) => pauseWorkflowFile(type, hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: (result) => adopt(result, true),
    onError: (error) => writeFailed(error, copy.pauseFailed),
  }));

  const resume = createMutation(() => ({
    mutationFn: (hash: string) => resumeWorkflowFile(type, hash),
    onMutate: () => {
      failure = null;
    },
    onSuccess: (result) => adopt(result, false),
    onError: (error) => writeFailed(error, copy.resumeFailed),
  }));

  /**
   * Deletes the file, then the schedules the person asked to delete with it. The file goes first:
   * it is what the person asked for, and its write is guarded by the hash the page read. A delete
   * the Bureau made and the engine could not apply has still removed the file, so it goes on as a
   * delete does. A schedule that then cannot be deleted is left, and named, never undone.
   */
  const removal = createMutation(() => ({
    mutationFn: async (input: {
      readonly hash: string;
      readonly schedules: readonly DeleteDialogSchedule[];
    }): Promise<readonly DeleteDialogSchedule[]> => {
      try {
        await deleteWorkflowFile(type, input.hash);
      } catch (error) {
        if (!isApplyFailure(error)) throw error;
      }
      const left: DeleteDialogSchedule[] = [];
      for (const schedule of input.schedules) {
        try {
          await cancelSchedule(client, schedule.id);
        } catch {
          left.push(schedule);
        }
      }
      return left;
    },
    onMutate: () => {
      failure = null;
      deleteError = undefined;
    },
    onSuccess: (left) => {
      confirmingDelete = false;
      for (const schedule of left) {
        showToast(copy.deleteDialog.scheduleLeft(schedule.label), { variant: 'danger' });
      }
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.schedules(type) });
      leaveForTheList();
    },
    onError: deleteFailed,
  }));

  /**
   * A delete the Bureau refused. A file that changed on disk, or is gone, is the page's own state,
   * so the dialog closes on it; any other refusal stays in the dialog, whose button is the retry.
   */
  function deleteFailed(error: unknown): void {
    const fault = agentFaultOf(error);
    switch (fault.kind) {
      case 'stale':
      case 'not-found':
        confirmingDelete = false;
        failWith(fault, copy.deleteFailed);
        return;
      case 'forbidden':
        deleteError = copy.forbidden;
        return;
      case 'identifier-taken':
        deleteError = copy.deleteFailed;
        return;
      case 'rejected':
      case 'other':
        deleteError = fault.message;
        return;
    }
  }

  /**
   * Duplicate: a paused copy of the file under a new identifier (`workflow-duplicate.ts`), whose
   * page opens once the Bureau has written it. Nothing on this page changes before then.
   */
  const duplicate = createMutation(() => ({
    mutationFn: () => {
      const text = file?.text ?? null;
      if (text === null) throw new DuplicateRefused(copy.page.menu.duplicateFailed);
      return duplicateWorkflowFile(type, text, file?.title ?? null);
    },
    onMutate: () => {
      failure = null;
    },
    onSuccess: (result) => {
      void queryClient.invalidateQueries({ queryKey: queryKeys.workflowCatalog.list() });
      router.navigate(workflowTypePath(result.id));
    },
    onError: (error) => {
      const fault = agentFaultOf(error);
      const title = copy.page.menu.duplicateFailed;
      failure = {
        title,
        message:
          fault.kind === 'forbidden'
            ? copy.forbidden
            : fault.kind === 'rejected' || fault.kind === 'other'
              ? fault.message
              : title,
      };
    },
  }));

  const busy = $derived(
    pause.isPending || resume.isPending || removal.isPending || duplicate.isPending,
  );

  /** Runs a write against the hash of the file the page read, when the file has one. */
  function act(write: (hash: string) => void): void {
    const hash = file?.hash;
    if (hash !== undefined && hash !== null) write(hash);
  }

  /**
   * The schedules that run the workflow from outside its file, which the delete dialog names and
   * offers to delete with it. The schedule the file defines is the Bureau's, and goes with the file.
   */
  const deleteSchedules = $derived<DeleteDialogSchedule[]>(
    (schedules.data ?? [])
      .filter(
        (schedule) =>
          schedule.id !== file?.schedule?.id &&
          !schedule.id.startsWith(`bureau-workflow-schedule:${type}:`),
      )
      .map((schedule) => ({
        id: schedule.id,
        label: schedule.description ?? schedule.id,
        paused: schedule.status === 'paused',
      })),
  );

  function openDelete(): void {
    deleteError = undefined;
    confirmingDelete = true;
  }

  function confirmDelete(alsoSchedules: boolean): void {
    if (busy) return;
    act((hash) => removal.mutate({ hash, schedules: alsoSchedules ? deleteSchedules : [] }));
  }

  /** Whether the file can be copied: one the Bureau loaded, whose text the page has. */
  const canDuplicate = $derived(
    file !== undefined && file.state === 'ready' && file.text !== null,
  );

  /** Reads the file again, which discards what the page believed of it. */
  async function reload(): Promise<void> {
    const result = await resolution.refetch();
    if (result.isError) {
      failWith(agentFaultOf(result.error), copy.loadFailed.title);
      return;
    }
    stale = false;
    unapplied = false;
    failure = null;
    if (result.data === null) workflowIsGone();
  }

  // Both services no longer know the type: it was deleted after the frame looked. That is the
  // frame's not-found state, so it is asked to look again.
  $effect(() => {
    if (resolution.data === null) untrack(workflowIsGone);
  });

  function go(event: MouseEvent, target: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(target);
  }

  const editPath = workflowEditPath(type);
  const editJsonPath = workflowEditJsonPath(type);
  const internalPath = internalWorkflowsPath();
  const condition = $derived(stale ? 'stale' : 'ready');
  const acceptedSignals = $derived(
    resolved?.kind === 'code' ? (resolved.definition.signals ?? []) : awaitedSignals(document),
  );
  /** The engine's definition of the type: a code type's own, or the one it loaded a ready file as. */
  const definition = $derived(resolved?.definition);
  const description = $derived(
    resolved?.kind === 'agent-authored'
      ? (file?.description ?? null)
      : (definition?.description ?? null),
  );
  const details = $derived(definitionDetails(definition, acceptedSignals));
  // What starts the workflow: a file's trigger (for a file that cannot load, the newest version that
  // ran, which is the last the Bureau could read), or the schedules the engine has for a code type.
  const starts = $derived(
    file !== undefined
      ? triggerSummary(document?.trigger ?? revisions.data?.[0]?.document.trigger ?? null)
      : schedulesSummary(schedules.data ?? null),
  );
  const engineType = isEngineType(type);
  // A file that loaded declares its schemas itself; otherwise the engine's contract does.
  const inputSchema = $derived(schemaOf(file?.inputSchema, definition, 'inputSchema'));
  const outputSchema = $derived(schemaOf(file?.outputSchema, definition, 'outputSchema'));
  const invalidFile = $derived(file !== undefined && file.state === 'invalid');
  /**
   * A run starts from a ready, unpaused file or from a type that code registered; the types the
   * Bureau registers to run itself start themselves, so they offer no Start run.
   */
  const canStart = $derived(
    !engineType &&
      resolved !== undefined &&
      (resolved.kind === 'code' || (resolved.file.state === 'ready' && !resolved.file.paused)),
  );
  const runSetupPath = workflowRunSetupPath(type);

  // The steps of a file that cannot load are the last good version's, read from the Bureau's history.
  const savedSteps = createQuery(
    () => ({
      queryKey: queryKeys.workflowCatalog.savedSteps(type),
      queryFn: ({ signal }) => getLatestSavedSteps(type, { signal }),
      enabled: invalidFile,
      retry: false,
    }),
    undefined,
  );
  /** The steps the Overview lists: the file's, the last good version's for an invalid file, none for a code type. */
  const overviewSteps = $derived.by<readonly WorkflowStepSource[] | undefined>(() => {
    if (!invalidFile) return document?.steps;
    // A file that cannot load shows the last good version's steps, never its own broken ones. With
    // no saved version there is nothing to show, which is not the same as a workflow with no
    // steps, so the section is left out rather than saying "no steps".
    const saved = (savedSteps.data ?? []).flatMap((step) =>
      typeof step['kind'] === 'string' ? [{ ...step, kind: step['kind'] }] : [],
    );
    return saved.length === 0 ? undefined : saved;
  });

  const agentName = $derived(
    file?.agent === null || file?.agent === undefined ? null : agentLabel(file.agent, undefined),
  );
  const internal = $derived(
    engineType ? internalWords(type, definition?.description ?? null) : null,
  );
  /** What an internal workflow's Overview says in place of steps and a contract it does not show. */
  const internalNote = $derived.by(() => {
    if (!engineType) return undefined;
    const known = copy.page.internalOverviewByType;
    return Object.hasOwn(known, type)
      ? known[type as keyof typeof known]
      : copy.page.internalOverview;
  });
  /** What the workflow is for: an internal one in Interborough's words, else the file's or the engine's. */
  const summary = $derived.by(() => {
    const short = copy.page.internalSummaryByType;
    if (engineType && Object.hasOwn(short, type)) return short[type as keyof typeof short];
    return internal?.description ?? description;
  });
  /** The title: an internal workflow's in words, a file's own, else the identifier. */
  const ownTitle = $derived(file?.title?.trim() ?? '');
  const heading = $derived(internal?.title ?? (ownTitle === '' ? type : ownTitle));
  const titled = $derived(heading !== type);
  // The trail reads "Workflows › Release notes": the title, once it is known, in place of the identifier.
  usePageLabel(() => ({
    path: workflowTypePath(type),
    label: resolved === undefined ? undefined : heading,
  }));

  /** The newest run, `undefined` until the engine has said. */
  const lastRun = $derived(headline.data === undefined ? undefined : headline.data.newest);

  const fileSchedule = $derived(document?.trigger.kind === 'schedule');
  /** The name the file gives its schedule, when its trigger is one. */
  const scheduleName = $derived.by(() => {
    const named = fileSchedule ? document?.trigger['name'] : undefined;
    return typeof named === 'string' ? named : undefined;
  });
  const headerSchedules = $derived<HeaderSchedule[]>(
    (schedules.data ?? []).map((schedule) => ({
      label: scheduleName ?? schedule.description ?? schedule.id,
      href: scheduleDetailPath(schedule.id),
      status: schedule.status === 'paused' ? 'paused' : 'active',
      cadence: scheduleLabel(schedule),
    })),
  );

  /** The lines under the title, in the order they are read. Offline, the file and schedule lines are left out. */
  const lines = $derived.by<HeaderLine[]>(() => {
    if (resolved === undefined) return [];
    if (engineType) {
      return [
        builtInLine({
          name: type,
          lastRunAt: headline.data === undefined ? undefined : (lastRun?.createdAt ?? null),
        }),
      ];
    }
    const offline = connection.unreachable;
    const found = [
      startsLine({ trigger: starts, canStart, agent: agentName }),
      lastRunLine({
        lastRun,
        fileName: file === undefined || offline ? null : `${type}.json`,
        runHref: (runId) => workflowRunPath(type, runId),
      }),
      file === undefined || offline
        ? null
        : scheduleLine({ schedules: headerSchedules, definedInFile: fileSchedule }),
    ];
    return found.filter((line): line is HeaderLine => line !== null);
  });

  /** Where the JSON of a file that cannot load stops being JSON, so the banner can name the line. */
  const located = $derived(
    file?.problem?.code === 'invalid-json' && file.text !== null
      ? locateJsonProblem(file.text)
      : null,
  );

  type TabValue = 'overview' | 'code' | 'runs' | 'history';
  /**
   * The tabs this workflow has. A type the Bureau registers for itself has only Overview and Runs:
   * there is no source to show and no version to install. An invalid file keeps all four.
   */
  const tabs = $derived<readonly TabValue[]>([
    'overview',
    ...(engineType ? [] : (['code'] as const)),
    'runs',
    ...(engineType ? [] : (['history'] as const)),
  ]);
  /** A tab's name, with its count after the label once the count is known. */
  function tabName(tab: TabValue): string {
    const label = copy.page.tabs[tab];
    const count =
      tab === 'runs'
        ? headline.data?.total
        : tab === 'history'
          ? revisions.data?.length
          : undefined;
    return count === undefined ? label : copy.page.tabWithCount(label, count);
  }

  let signalOpen = $state(false);

  // The URL owns the tab, so a tab can be linked and the back button returns to it. `activeTab`
  // follows `?tab=`, and a tab the person picks writes the address from Tabs' `onValueChange`, so a
  // jump through history to an older `?tab=` entry is only read, never written back over.
  // Overview is the address with no `tab`.
  let activeTab = $state(untrack(() => router.search.get('tab') ?? 'overview'));

  /** Puts a tab the person picked in the address. */
  function writeTab(next: string): void {
    const search = new URLSearchParams(router.search);
    if ((search.get('tab') ?? 'overview') === next) return;
    if (next === 'overview') search.delete('tab');
    else search.set('tab', next);
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    router.navigate(`${workflowTypePath(type)}${query}`);
  }

  $effect(() => {
    const fromUrl = router.search.get('tab') ?? 'overview';
    if (fromUrl !== activeTab) activeTab = fromUrl;
  });

  // An address that names a tab this workflow does not have is Overview: say so in the address,
  // in place, so it is not a history entry of its own.
  $effect(() => {
    const named = router.search.get('tab');
    if (named === null || tabs.some((tab) => tab === named)) return;
    const search = new URLSearchParams(router.search);
    search.delete('tab');
    const query = search.size === 0 ? '' : `?${search.toString()}`;
    router.navigate(`${workflowTypePath(type)}${query}`, { replace: true });
  });
</script>

{#snippet headerActions()}
  {#if engineType}
    <Button
      variant="secondary"
      size="sm"
      href={router.href(internalPath)}
      onclick={(event) => go(event, internalPath)}>{copy.page.seeInternal}</Button
    >
  {:else if resolution.isPending}
    <!-- The route says what the page is, so its actions are there at once, off until the type loads. -->
    <Button variant="secondary" size="sm" disabled>{copy.editAction}</Button>
    <Button variant="primary" size="sm" disabled>{copy.page.startAction}</Button>
  {/if}
  {#if file !== undefined && actions?.edit === true}
    <Button
      data-changes
      href={router.href(invalidFile ? editJsonPath : editPath)}
      variant="secondary"
      size="sm"
      onclick={(event) => go(event, invalidFile ? editJsonPath : editPath)}
      >{copy.editAction}</Button
    >
  {/if}
  {#if canStart}
    <Button
      data-changes
      variant="primary"
      size="sm"
      href={router.href(runSetupPath)}
      onclick={(event) => go(event, runSetupPath)}>{copy.page.startAction}</Button
    >
  {:else if file !== undefined && actions?.resume === true && file.paused}
    <!-- A paused file swaps Start run for Resume, and the menu does not repeat it. -->
    <Button
      data-changes
      variant="primary"
      size="sm"
      disabled={busy || file.hash === null}
      onclick={() => act(resume.mutate)}>{copy.resumeAction}</Button
    >
  {:else if invalidFile}
    <!-- Off until the file is fixed, and the banner under the tabs says why. -->
    <Button variant="primary" size="sm" aria-disabled="true">{copy.page.startAction}</Button>
  {/if}
  <WorkflowMoreMenu
    canSignal={actions?.signal === true}
    onSendSignal={() => (signalOpen = true)}
    onDuplicate={canDuplicate ? () => duplicate.mutate() : undefined}
    onPause={file !== undefined && actions?.pause === true && !file.paused
      ? () => act(pause.mutate)
      : undefined}
    onDelete={actions?.delete === true ? openDelete : undefined}
    {busy}
  />
{/snippet}

{#snippet headingText()}
  {#if titled}
    {heading}
    {#if internal === null}
      <code class="ib-identifier" data-testid="workflow-identifier">{type}</code>
    {/if}
  {:else if file !== undefined}
    <code class="ib-workflow-row__id">{type}</code>
  {:else}
    {type}
  {/if}
{/snippet}

{#snippet headingStatus()}
  {#if invalidFile}
    <StatusDot word="Can't load" data-testid="workflow-state" />
  {:else if file?.paused === true}
    <StatusDot word="Paused" data-testid="workflow-state" />
  {/if}
{/snippet}

<article class="ib-workflow" data-page="workflow-detail" data-condition={condition}>
  <PageHeader
    headingLevel={1}
    title={headingText}
    titleText={heading}
    actions={headerActions}
    statusPlacement="inline"
    {...invalidFile || file?.paused === true ? { status: headingStatus } : {}}
  />
  <div class="ib-workflow__identity">
    {#if summary}
      <p class="ib-workflow__description" data-testid="workflow-description">{summary}</p>
    {/if}
    {#each lines as line (line.id)}
      <WorkflowHeaderLine {line} />
    {/each}
  </div>

  {#if connection.unreachable && !restartActivity.active}
    <Banner
      preset={connectionBannerPreset(connection)}
      subject={copy.page.offlineSubject}
      dataUpdatedAt={connection.lastHealthyAt}
      retryInSeconds={connection.retryInSeconds}
      attempt={connection.browserOffline || connection.attempt === 0
        ? undefined
        : connection.attempt}
      maxAttempts={CONNECTION_MAX_ATTEMPTS}
      onRetry={() => void connection.retryNow()}
    />
  {/if}

  {#if stale}
    <Alert variant="warning">
      <p class="ib-workflow__alert-title">{copy.stale.title}</p>
      <p class="ib-workflow__alert-body">{copy.stale.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void reload()}
        >{copy.stale.action}</Button
      >
    </Alert>
  {/if}

  {#if unapplied}
    <Alert variant="warning">
      <p class="ib-workflow__alert-title">{copy.applyFailed.title}</p>
      <p class="ib-workflow__alert-body">{copy.applyFailed.description}</p>
    </Alert>
  {/if}

  {#if failure !== null}
    <Alert variant="danger" dismissible onDismiss={() => (failure = null)}>
      <p class="ib-workflow__alert-title">{failure.title}</p>
      <p class="ib-workflow__alert-body">{failure.message}</p>
    </Alert>
  {/if}

  {#if resolution.isError}
    <Alert variant="danger">
      <p class="ib-workflow__alert-title">{copy.loadFailed.title}</p>
      <p class="ib-workflow__alert-body">{copy.loadFailed.description}</p>
      <Button variant="secondary" size="sm" onclick={() => void resolution.refetch()}
        >{RETRY_LABEL}</Button
      >
    </Alert>
  {:else}
    <!-- The tabs come from the route, so they are here while the type loads; counts wait for data. -->
    <Tabs bind:value={activeTab} onValueChange={writeTab}>
      <Tabs.List label={copy.page.tabsLabel}>
        {#each tabs as tab (tab)}
          <Tabs.Trigger value={tab} label={copy.page.tabs[tab]}>{tabName(tab)}</Tabs.Trigger>
        {/each}
      </Tabs.List>

      {#if resolved === undefined}
        <!-- Nothing is drawn for the first 300 ms, then rows in the shape of the page. -->
        {#each tabs as tab (tab)}
          <Tabs.Panel value={tab}>
            <Skeleton
              variant="list"
              rows={4}
              statusColumn={false}
              delay={300}
              label={copy.page.loadingLabel}
            />
          </Tabs.Panel>
        {/each}
      {:else}
        <Tabs.Panel value="overview">
          {#if file !== undefined && file.problem !== null}
            <WorkflowFileProblem
              fileName={`${type}.json`}
              problem={file.problem}
              {located}
              actionLabel={copy.page.problem.openCode}
              onAction={() => writeTab('code')}
            />
          {/if}
          <WorkflowOverview
            steps={overviewSteps}
            {inputSchema}
            {outputSchema}
            details={engineType ? NO_DETAILS : details}
            schedules={schedules.data}
            schedulesFailed={!engineType && schedules.isError}
            showSchemas={!invalidFile && !engineType}
            listSchedules={file === undefined && !engineType}
            {internalNote}
          />
        </Tabs.Panel>
        {#if tabs.includes('code')}
          <Tabs.Panel value="code">
            <WorkflowCode
              {type}
              kind={resolved.kind}
              text={file?.text ?? null}
              {document}
              {path}
              problem={file?.problem ?? null}
              onEditAsJson={() => router.navigate(editJsonPath)}
            />
          </Tabs.Panel>
        {/if}
        <Tabs.Panel value="runs">
          <RecentRuns
            {type}
            kind={resolved.kind}
            title={heading}
            agentName={file?.agent ?? null}
            {canStart}
            paused={file?.paused === true}
          />
        </Tabs.Panel>
        {#if tabs.includes('history')}
          <Tabs.Panel value="history">
            {#if resolved.kind === 'code'}
              <WorkflowRevisionsPanel workflowName={type} />
            {:else}
              <RevisionHistory id={type} currentVersion={file?.version ?? null} />
            {/if}
          </Tabs.Panel>
        {/if}
      {/if}
    </Tabs>
  {/if}
</article>

{#if file !== undefined}
  <DeleteWorkflowDialog
    bind:open={confirmingDelete}
    name={heading}
    fileName={`${type}.json`}
    directory={hostPaths.data?.workflowDirectory ?? copy.fallbackDirectory}
    schedules={deleteSchedules}
    busy={removal.isPending}
    error={deleteError}
    onConfirm={confirmDelete}
    onCancel={() => (deleteError = undefined)}
  />
{/if}

{#if signalOpen}
  <SignalForm {document} onClose={() => (signalOpen = false)} />
{/if}

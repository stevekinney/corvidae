<script lang="ts">
  /**
   * The workflow builder, shared by `/workflows/new` and `/workflows/:workflow/edit` (board
   * PageWorkflowBuilder): a Builder tab (Title and the ID it makes, Description, Starts, the steps
   * as numbered cards, then Input and Output) and a JSON tab, over a footer that reads the whole
   * workflow back in one sentence beside the page's Cancel and primary action. The page owns the
   * file's text. The builder reads it and writes a changed copy back through `onTextChange`, and
   * the JSON tab edits the same text, so each view shows the other's edits and neither can lose
   * what the other wrote (`workflow-builder-model.ts`). The steps are drawn by
   * `workflow-step-list.svelte`, one list at any depth (a case, an otherwise path, side-by-side
   * lists, a repeat's steps), which reads the text, the catalogs and the one way to change the text
   * from the host this component provides (`workflow-builder-host.ts`). Below 640 pixels the
   * builder shows read-only fields and JSON, hides field editing actions, and disables the footer's
   * primary action. The tabs still switch, with their read-only status beside them (row 05n).
   *
   * Create workflow's problems (the ID, what starts it, each step) are said at their fields and
   * outline their step once the page asks to `showProblems`, from two of them in one line above the
   * footer, and `focusProblem()` takes the person to the first. Text that is not a JSON object is
   * the JSON tab's to fix: the Builder tab is off with the reason, and the footer says which line
   * to fix in place of the read-back.
   *
   * An existing workflow's ID is a read-only line. The edit page puts its notices in the builder's
   * slots (a file that changed on disk under the tabs, the version a save makes above the footer),
   * says the version in the footer through `status`, and opens a file that cannot load on the JSON
   * tab through `initialTab`.
   */
  import {
    Alert,
    Button,
    Callout,
    FormSection,
    Input,
    JsonEditor,
    JsonSchemaEditor,
    Segment,
    SegmentedControl,
    Tabs,
    Textarea,
    humanizeIdentifier,
    type JsonSchemaValue,
  } from '@lostgradient/cinder';
  import { Plus } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { tick, untrack, type Snippet } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy/workflows.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { readScheduleAttention } from '../../lib/bureau-attention.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { listContributedKinds } from '../../lib/bureau-plugin-kinds.ts';
  import { readWorkflowCatalog, type WorkflowCatalog } from '../../lib/bureau-workflow-catalog.ts';
  import ContributedConfigurationForm from '../../lib/contributed-configuration-form.svelte';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import { browserTimeZone } from '../schedules/cadence.ts';
  import { loadModelAgents } from '../schedules/schedule-row-context.ts';
  import ScheduleWhen from '../schedules/schedule-when.svelte';
  import { ROOT_ADDRESS } from './workflow-builder-addresses.ts';
  import {
    provideBuilderHost,
    type BuilderHost,
    type BuilderOption,
    type CatalogState,
  } from './workflow-builder-host.ts';
  import {
    forEachStep,
    identifierFromTitle,
    readBuilder,
    ROOT_LIST,
    setContributedTrigger,
    setDescription,
    setName,
    setSchema,
    setScheduleFields,
    setTitle,
    setTitleDerivingName,
    setTrigger,
    type BuilderSchema,
    type SchemaKey,
  } from './workflow-builder-model.ts';
  import type { DocumentProblem } from './workflow-issue-line.ts';
  import { scheduleFieldsOf, scheduleValueOf } from './workflow-schedule-value.ts';
  import {
    problemSummary,
    workflowProblems,
    type WorkflowProblem,
  } from './workflow-builder-problems.ts';
  import { locateJsonProblem } from './workflow-source.ts';
  import WorkflowStepList from './workflow-step-list.svelte';
  import { StepKeys } from './workflow-step-keys.svelte.ts';

  interface Props {
    /** The file's text, which the page owns. */
    text: string;
    /** Takes the text after an edit. */
    onTextChange: (next: string) => void;
    /**
     * A new workflow's ID is made from its title or typed; an existing workflow's is fixed, and a
     * title never changes it.
     */
    mode: 'create' | 'edit';
    /** Why the text cannot be saved, or the Bureau's words for a document it refused. */
    error: string;
    /** The JSON editor's id and words, which the page's tests and labels already know. */
    jsonId: string;
    jsonLabel: string;
    jsonDescription: string;
    /**
     * The footer's actions, at the right of the read-back: Cancel and the one primary action. Told
     * whether the builder is read-only (below 640 pixels), so its primary action stays visible but
     * disabled rather than inviting a save it cannot make (note N3).
     */
    actions?: Snippet<[boolean]>;
    /**
     * Whether the page has asked to save: the problems of the workflow are then said at their
     * fields and, from two, in one line above the footer. Before that nothing is called wrong.
     */
    showProblems?: boolean;
    /** An ID the Bureau said is already a file, so a text that still names it is a problem. */
    takenId?: string;
    /** The save is in flight: the whole form is read-only until it answers. */
    saving?: boolean;
    /**
     * Why the file could not be written, said above the footer at the action. It carries what the
     * Bureau said, and "Nothing was saved." closes it.
     */
    failure?: { readonly title: string; readonly message: string } | null;
    /**
     * The tab the builder opens on. Text the builder cannot draw opens on the JSON tab whatever
     * this says; the edit page opens a file the Bureau cannot load there too.
     */
    initialTab?: 'builder' | 'json';
    /**
     * What the footer says in place of the read-back, such as the version a save makes ("Save as
     * version 1.4.0."). Text the builder cannot draw still says which line to fix.
     */
    status?: string;
    /** Drawn under the tabs, above both panels: a notice that holds for either view of the file. */
    notice?: Snippet;
    /** Drawn above the footer, before a failure: a notice about what saving does. */
    aboveFooter?: Snippet;
    /**
     * A line of JSON that parses but that the Bureau refused as a workflow, which the page found
     * when the person pressed Create or Save (row 65z): the JSON tab marks it, the Builder tab is off
     * with the footer's "Fix line 21 to return to the builder." as its reason. The page clears it
     * when the text changes.
     */
    documentProblem?: DocumentProblem | null;
  }

  let {
    text,
    onTextChange,
    mode,
    error,
    jsonId,
    jsonLabel,
    jsonDescription,
    actions,
    showProblems = false,
    takenId,
    saving = false,
    failure = null,
    initialTab = 'builder',
    status,
    notice,
    aboveFooter,
    documentProblem = null,
  }: Props = $props();

  const copy = WORKFLOW_COPY.builder;
  const takenLink = WORKFLOW_COPY.creator.takenLink;

  /** The footer's sentence, which a disabled Builder tab points at as its reason. */
  const READ_BACK_ID = 'workflow-builder-read-back';
  const ID_CHANGE_ID = 'workflow-builder-id-change';
  /** A new schedule's cadence: weekdays at 9:00 AM (row 65d). */
  const DEFAULT_SCHEDULE_SPEC = '0 9 * * 1-5';
  /** A fire that comes while a run is going is skipped, unless the file says otherwise. */
  const DEFAULT_OVERLAP = 'skip';

  // Text the builder cannot read opens on the JSON tab, where it is fixed.
  let tab = $state<'builder' | 'json'>(
    untrack(() => (readBuilder(text) === undefined ? 'json' : initialTab)),
  );

  /** Below 640 pixels the Builder tab can be read but not changed; so is the whole form while it saves. */
  const readOnly = $derived(phoneViewport.current);
  const locked = $derived(readOnly || saving);

  /** The JSON tab's editor, which finds and focuses the line its text stops being JSON on. */
  let jsonEditor = $state<{ focusProblem: () => void; focusLine: (line: number) => void }>();

  /**
   * The agents an agent step can name. A host that cannot list them leaves the agent to be typed;
   * while they load, the select offers the one the file names.
   */
  const agents = createQuery(() => ({
    queryKey: queryKeys.agents.list(),
    queryFn: ({ signal }: { signal: AbortSignal }) => listAgents({ signal }),
    retry: false,
  }));

  /**
   * The activities a step can call and the plugin code workflows a `workflow` step can start, from
   * one read of `bureau.workflows.catalog`. It answers once for every list of steps on the page. A
   * failed read keeps what the file holds and offers a retry; it never says that nothing is
   * provided.
   */
  let catalogsRequested = $state(false);
  /** A card of an activity or a workflow is drawn from the catalogs, so a file that has one reads them. */
  const stepsNeedCatalogs = $derived.by(() => {
    let needed = false;
    // Read without names, so the read-back's own use of the catalogs cannot make this wait on them.
    forEachStep(readBuilder(text)?.steps ?? [], (step) => {
      if (step.kind === 'activity' || step.kind === 'workflow') needed = true;
    });
    return needed;
  });
  const catalogsEnabled = $derived(catalogsRequested || stepsNeedCatalogs);

  const catalogQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.builderCatalog(),
    queryFn: ({ signal }: { signal: AbortSignal }) => readWorkflowCatalog({ signal }),
    enabled: catalogsEnabled,
    retry: false,
  }));

  /** One read answers both lists, so they load, fail and retry together. */
  function catalogState<Entry>(
    pick: (catalog: WorkflowCatalog) => readonly Entry[],
  ): CatalogState<Entry> {
    if (catalogQuery.isError) return { status: 'failed', retry: () => void catalogQuery.refetch() };
    return catalogQuery.data === undefined
      ? { status: 'loading' }
      : { status: 'ready', entries: pick(catalogQuery.data) };
  }

  const activities = $derived(catalogState((catalog) => catalog.activities));
  const codeWorkflows = $derived(catalogState((catalog) => catalog.workflows));

  /** What a person reads for an activity or a workflow: the title the catalog gives, else the id in words. */
  function titleOfActivity(handler: string): string {
    const found =
      activities.status === 'ready'
        ? activities.entries.find((entry) => entry.id === handler)
        : undefined;
    return found?.title ?? humanizeIdentifier(handler, { casing: 'sentence' });
  }
  function titleOfWorkflow(id: string): string {
    const found =
      codeWorkflows.status === 'ready'
        ? codeWorkflows.entries.find((entry) => entry.id === id)
        : undefined;
    return found?.title ?? humanizeIdentifier(id, { casing: 'sentence' });
  }

  const view = $derived(
    readBuilder(text, {
      agentName: (identifier) => agentLabel(identifier, agents.data),
      activityName: titleOfActivity,
      workflowName: titleOfWorkflow,
      // A saved workflow can be started by the person editing it; a new one cannot yet (row 65j).
      canStart: mode === 'edit',
    }),
  );

  /**
   * The text this builder last wrote. A text that is another was written by something else (the JSON
   * tab, a file that changed on disk), which the steps' keys cannot follow, so they start over.
   */
  // svelte-ignore state_referenced_locally
  let lastWritten = text;
  const keys = new StepKeys();

  $effect.pre(() => {
    if (text === lastWritten) return;
    lastWritten = text;
    untrack(() => keys.reset());
  });

  /** Writes the text an edit made. `follow` moves the keys as the edit moved the steps. */
  function write(next: string, follow?: () => void): void {
    if (next === text) return;
    lastWritten = next;
    follow?.();
    onTextChange(next);
  }

  /**
   * The builder cannot draw text that is not a JSON object, so its tab is off with the reason and
   * the JSON tab holds the fix. `jsonProblem` is where the text stops being JSON, or `null` when it
   * parses but is not an object.
   */
  const unreadable = $derived(view === undefined);
  // A document the Bureau refused at a line is the JSON tab's to fix as well (row 65z).
  const blocked = $derived(unreadable || documentProblem !== null);
  const jsonProblem = $derived(unreadable ? locateJsonProblem(text) : null);
  const fixLine = $derived(
    copy.json.fixLine(unreadable ? (jsonProblem?.line ?? 1) : (documentProblem?.line ?? 1)),
  );
  /** Valid JSON that is not an object: the editor marks its first line and says so in its status. */
  const notWorkflow = $derived(unreadable && jsonProblem === null && text.trim() !== '');
  /** What the JSON editor marks for valid JSON that is not a workflow, and the status it says. */
  const notWorkflowMarks = $derived.by(() => {
    if (notWorkflow) {
      return {
        statusLabel: copy.json.notWorkflow,
        diagnostics: [{ line: 1, message: copy.json.notObject }],
      };
    }
    if (!unreadable && documentProblem !== null) {
      return { statusLabel: copy.json.notWorkflow, diagnostics: [documentProblem] };
    }
    return {};
  });

  $effect(() => {
    if (blocked && tab === 'builder') tab = 'json';
  });

  /** Everything wrong with the workflow, whether or not the page has asked to show it. */
  const problems = $derived(
    workflowProblems(text, { mode, ...(takenId === undefined ? {} : { takenId }) }),
  );
  const visible = $derived(showProblems ? problems : []);
  const summary = $derived(problemSummary(visible));
  /** The problem said at a field, by the field's id. */
  function problemAt(fieldId: string): WorkflowProblem | undefined {
    return visible.find((problem) => problem.fieldId === fieldId);
  }
  /** The `error` a field takes for its problem, or nothing for a field that has none. */
  function errorOf(fieldId: string): { error?: string } {
    const problem = problemAt(fieldId);
    return problem === undefined ? {} : { error: problem.message };
  }
  /** Whether the step at an address has something to fix, which outlines its card. */
  function stepHasProblem(address: string): boolean {
    return visible.some((problem) => problem.address === address);
  }
  /** The ID's problem, when the page has asked to show it and the ID is the Bureau's to refuse. */
  const idProblem = $derived(
    visible.find((problem) => problem.kind === 'id' || problem.kind === 'id-taken'),
  );
  /** The ID problem the JSON tab says under its editor, whose frame goes red for it. */
  const jsonError = $derived(error !== '' ? error : (idProblem?.message ?? ''));

  /**
   * Takes the person to the first problem: the line the JSON stops being JSON on, the ID (on the
   * JSON tab, the editor that holds it), or the first field of the builder that is wrong.
   */
  export async function focusProblem(): Promise<void> {
    if (unreadable) {
      tab = 'json';
      await tick();
      jsonEditor?.focusProblem();
      return;
    }
    if (documentProblem !== null) {
      // The line the Bureau refused, which the JSON tab marks (row 65z).
      tab = 'json';
      await tick();
      jsonEditor?.focusLine(documentProblem.line);
      return;
    }
    const first = problems[0];
    if (first === undefined) return;
    if (tab === 'json' && (first.kind === 'id' || first.kind === 'id-taken')) {
      jsonEditor?.focusProblem();
      return;
    }
    tab = 'builder';
    await tick();
    document.getElementById(first.fieldId)?.focus();
  }

  /** The agents the steps name at any depth, each once and in order, for the provider check. */
  const namedAgents = $derived.by(() => {
    const names = new Set<string>();
    forEachStep(view?.steps ?? [], (step) => {
      if (step.kind === 'agent' && step.agent !== '') names.add(step.agent);
    });
    return [...names].sort();
  });

  /**
   * The named agents that need a model while no provider is connected, so they won't run until one
   * is. Assistant and Echo are scripted and never among them. A read that fails says nothing: a
   * step is never said to be blocked on a guess, and the workflow saves either way.
   */
  const blockedQuery = createQuery(() => ({
    queryKey: queryKeys.workflows.builderBlockedAgents(namedAgents),
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const [attention, models] = await Promise.all([
        readScheduleAttention({ signal }),
        loadModelAgents(namedAgents, { signal }),
      ]);
      return attention.noProvider ? [...models] : [];
    },
    enabled: namedAgents.length > 0,
    retry: false,
  }));
  const blockedAgents = $derived(new Set(blockedQuery.data ?? []));

  /**
   * The trigger kinds running plugins contribute. A host that cannot say (an older Bureau, a failed
   * read) offers the built-in triggers alone: the answer only ever adds choices. A file whose trigger
   * names a contributed kind says it is checking while this loads, and after a failed read keeps the
   * stored kind, says the read failed, and offers a retry: it never claims the plugin is missing.
   */
  const contributed = createQuery(
    () => ({
      queryKey: queryKeys.pluginKinds(),
      queryFn: ({ signal }: { signal: AbortSignal }) => listContributedKinds({ signal }),
      retry: false,
    }),
    undefined,
  );
  const triggers = $derived(contributed.data?.triggers ?? []);

  /** The contributed kind the file's trigger names, when a running plugin contributes it. */
  const contributedTrigger = $derived.by(() => {
    const trigger = view?.trigger;
    return trigger?.kind === 'contributed'
      ? triggers.find((kind) => kind.id === trigger.id)
      : undefined;
  });

  /** The contributed kind id the file's trigger names, running or not. */
  const storedTriggerId = $derived(
    view?.trigger?.kind === 'contributed' ? view.trigger.id : undefined,
  );

  /**
   * The Starts choices: the three built-in starts, then one per trigger kind a running plugin
   * contributes. A trigger the file holds but no loaded kind matches stays visible by its own kind,
   * so Starts never reads as another trigger while kinds load, after a failed read, or when the
   * plugin is off.
   */
  const triggerOptions = $derived([
    { value: 'manual', label: copy.triggers.manual },
    { value: 'schedule', label: copy.triggers.schedule },
    { value: 'signal', label: copy.triggers.signal },
    ...triggers.map((kind) => ({
      value: kind.id,
      label: copy.contributedTrigger(kind.id),
    })),
    ...(storedTriggerId !== undefined && contributedTrigger === undefined
      ? [{ value: storedTriggerId, label: copy.contributedTrigger(storedTriggerId) }]
      : []),
  ]);

  /** The start Starts shows: a built-in kind, a contributed kind, or none for a file with no trigger. */
  const triggerValue = $derived.by((): string | undefined => {
    const trigger = view?.trigger;
    if (trigger === undefined || trigger === null || trigger.kind === 'other') return undefined;
    return trigger.kind === 'contributed' ? trigger.id : trigger.kind;
  });

  /** The cadence the When block shows, or `undefined` for a spec it cannot draw, which stays a field. */
  const scheduleValue = $derived(
    view?.trigger?.kind === 'schedule' ? scheduleValueOf(view.trigger) : undefined,
  );

  /** The schedule UI may show an uncommitted invalid custom cadence. */
  let scheduleWhen = $state<{ isInvalid: () => boolean; focusProblem: () => boolean }>();

  /** Whether the visible schedule draft differs from the last cadence written to the workflow text. */
  export function hasInvalidSchedule(): boolean {
    return scheduleWhen?.isInvalid() === true;
  }

  /** Takes Create or Save to the invalid schedule field, when one is visible. */
  export function focusScheduleProblem(): boolean {
    return scheduleWhen?.focusProblem() ?? false;
  }

  function changeTriggerKind(kind: string): void {
    // SegmentedControl does not report a selected option again today, but keeping the draft intact
    // makes this handler correct for alternate controls and future control behavior too.
    if (kind === triggerValue) return;
    if (kind === 'schedule' && view?.trigger?.kind !== 'schedule') {
      // A new schedule starts on weekdays at 9:00 AM in the viewer's zone, skips a fire that comes
      // while a run is going, and does not catch up: every field the builder writes (row 65d).
      write(
        setScheduleFields(setTrigger(text, 'schedule', DEFAULT_SCHEDULE_SPEC), {
          timezone: browserTimeZone(),
          overlap: DEFAULT_OVERLAP,
          catchUp: false,
        }),
      );
    } else if (kind === 'manual' || kind === 'schedule' || kind === 'signal') {
      write(setTrigger(text, kind, ''));
    } else if (triggers.some((candidate) => candidate.id === kind)) {
      write(setContributedTrigger(text, kind, {}));
    }
  }

  /** Whether Change opened the ID of a new workflow whose ID its title made. */
  let idOpen = $state(false);

  /** The ID the title makes, or `''` when it has no letter in it. */
  const derivedId = $derived(identifierFromTitle(view?.title ?? ''));

  /**
   * A new workflow's ID collapses to one line ("ID morning-briefing, Change") while its title made
   * it and Change has not opened it. Without a title it is a field to type.
   */
  const idCollapsed = $derived(
    mode === 'create' &&
      !idOpen &&
      idProblem === undefined &&
      view !== undefined &&
      view.title.trim() !== '' &&
      derivedId !== '' &&
      view.name === derivedId,
  );

  function changeTitle(next: string): void {
    write(mode === 'create' ? setTitleDerivingName(text, next) : setTitle(text, next));
  }

  async function resetId(): Promise<void> {
    write(setName(text, derivedId));
    idOpen = false;
    await tick();
    document.getElementById(ID_CHANGE_ID)?.focus();
  }

  /** The agents a step's select offers: the catalog, and the one the file names when it is not there. */
  function agentOptions(current: string): BuilderOption[] {
    const catalog = agents.data ?? [];
    return [
      { value: '', label: copy.agentPlaceholder, disabled: true },
      ...(current !== '' && !catalog.some((agent) => agent.name === current)
        ? [{ value: current, label: agentLabel(current, catalog) }]
        : []),
      ...catalog.map((agent) => ({ value: agent.name, label: agentLabel(agent.name, catalog) })),
    ];
  }

  /** What every step card reads: the text, the one way to change it, and the Bureau's catalogs. */
  const host: BuilderHost = {
    get text() {
      return text;
    },
    get locked() {
      return locked;
    },
    keys,
    commit: write,
    errorOf,
    hasProblem: stepHasProblem,
    get agentsFailed() {
      return agents.isError;
    },
    agentOptions,
    agentNeedsProvider: (agent) => blockedAgents.has(agent),
    requestCatalogs: () => {
      catalogsRequested = true;
    },
    get activities() {
      return activities;
    },
    get workflows() {
      return codeWorkflows;
    },
    activityTitle: titleOfActivity,
    workflowTitle: titleOfWorkflow,
    showJson: () => {
      tab = 'json';
    },
  };
  provideBuilderHost(host);

  /** What "Add a field" opened: an empty schema shown in the editor, not yet written to the file. */
  let schemaOpened = $state<Record<SchemaKey, boolean>>({
    inputSchema: false,
    outputSchema: false,
  });

  /** The schema an opened, still empty Input or Output starts from. */
  const EMPTY_SCHEMA: Readonly<Record<string, unknown>> = { type: 'object', properties: {} };

  const NO_SCHEMA: BuilderSchema = { kind: 'none' };

  // hidden-label-allowed: the Starts section heading above the trigger kind control is its visible label
  const hiddenLabel = { labelVisible: false } as const;

  /** The file's Input or Output schema as the builder shows it. */
  function schemaFor(key: SchemaKey): BuilderSchema {
    return view?.[key] ?? NO_SCHEMA;
  }

  function shownSchema(schema: BuilderSchema): JsonSchemaValue {
    return (schema.kind === 'schema' ? schema.schema : EMPTY_SCHEMA) as JsonSchemaValue;
  }

  /**
   * Writes the editor's schema to the file. A schema is part of a workflow's version, so the empty
   * schema "Add a field" opens is not written until a field is added, and a value the format refuses
   * (a boolean schema) is turned back. Returns the schema the editor then shows.
   */
  function changeSchema(key: SchemaKey, next: JsonSchemaValue): JsonSchemaValue {
    const current = schemaFor(key);
    const shown = shownSchema(current);
    if (typeof next !== 'object' || next === null) return shown;
    const record = next as Readonly<Record<string, unknown>>;
    if (current.kind !== 'schema' && JSON.stringify(record) === JSON.stringify(EMPTY_SCHEMA)) {
      return shown;
    }
    write(setSchema(text, key, record));
    return next;
  }

  /** Follows a link inside the page without reloading it. */
  function go(event: MouseEvent, path: string): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(path);
  }
</script>

{#snippet schemaSection(key: SchemaKey, heading: string, description: string, empty: string)}
  {@const schema = schemaFor(key)}
  <!-- One column, the fields table alone: Field, Type, Description, Required and each row's
       actions in the section's full width, with no editor chrome around them (row 65s). -->
  <FormSection {heading} {description} columns={1}>
    {#if schema.kind === 'unreadable'}
      <p class="weft-workflow-builder__note">{copy.schemaUnreadable}</p>
    {:else if schema.kind === 'none' && (readOnly || !schemaOpened[key])}
      <div
        class="weft-workflow-builder__schema-empty"
        data-testid={`workflow-builder-${key}-empty`}
      >
        <p class="weft-workflow-builder__note">{empty}</p>
        {#if !readOnly}
          <Button
            variant="secondary"
            size="sm"
            label={copy.addField}
            onclick={() => (schemaOpened[key] = true)}
          >
            {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
          </Button>
        {/if}
      </div>
    {:else}
      <JsonSchemaEditor
        id={`workflow-builder-${key}`}
        variant="fields"
        schema={shownSchema(schema)}
        readonly={locked}
        onValueChangeRequest={(event) => changeSchema(key, event.schema)}
      />
    {/if}
  </FormSection>
{/snippet}

{#snippet resetIdAction()}
  <Button variant="ghost-accent" size="sm" onclick={resetId} label={copy.resetId} />
{/snippet}

<div class="weft-workflow-builder" data-testid="workflow-builder">
  <Tabs bind:value={tab}>
    <div class="weft-workflow-builder__tabs">
      <Tabs.List label={copy.tabsLabel}>
        <Tabs.Trigger
          value="builder"
          disabled={blocked}
          {...blocked ? { 'aria-describedby': READ_BACK_ID } : {}}>{copy.builderTab}</Tabs.Trigger
        >
        <Tabs.Trigger value="json">{copy.jsonTab}</Tabs.Trigger>
      </Tabs.List>
      {#if readOnly}<span class="weft-workflow-builder__read-only">{copy.readOnly}</span>{/if}
    </div>

    {#if notice !== undefined}
      <div class="weft-workflow-builder__notice">{@render notice()}</div>
    {/if}

    <Tabs.Panel value="builder">
      {#if view !== undefined}
        {#if error !== ''}
          <Alert variant="danger">{error}</Alert>
        {/if}

        <div
          class="weft-workflow-builder__body"
          inert={locked}
          data-read-only={readOnly ? '' : undefined}
        >
          <FormSection>
            <Input
              id="workflow-builder-title"
              label={copy.titleLabel}
              optional
              placeholder={copy.titlePlaceholder}
              value={view.title}
              onValueChange={changeTitle}
            />
            {#if mode === 'edit'}
              <!-- An existing workflow's ID is its file's name, so it is read, never changed (row 65p). -->
              <p class="weft-workflow-builder__id-line" data-testid="workflow-builder-id-line">
                <span class="weft-workflow-builder__id-label">{copy.idLabel}</span>
                <code id="workflow-builder-name" class="weft-workflow-builder__id">{view.name}</code
                >
                <span class="weft-workflow-builder__note">{copy.idFixed}</span>
              </p>
            {:else if readOnly && view.title.trim() !== '' && derivedId !== ''}
              <p class="weft-workflow-builder__id-line" data-testid="workflow-builder-id-line">
                <span class="weft-workflow-builder__id-label">{copy.idLabel}</span>
                <code class="weft-workflow-builder__id">{view.name}</code>
                <span class="weft-workflow-builder__note">{copy.idFixedOnCreate}</span>
              </p>
            {:else if idCollapsed}
              <p class="weft-workflow-builder__id-line" data-testid="workflow-builder-id-line">
                <span class="weft-workflow-builder__id-label">{copy.idLabel}</span>
                <code class="weft-workflow-builder__id">{view.name}</code>
                <Button
                  id={ID_CHANGE_ID}
                  variant="ghost-accent"
                  size="sm"
                  onclick={() => (idOpen = true)}
                  label={copy.idChange}
                />
                <span class="weft-workflow-builder__note">{copy.idFixedOnCreate}</span>
              </p>
            {:else if view.title.trim() === '' || derivedId === ''}
              <Input
                id="workflow-builder-name"
                label={copy.idLabel}
                placeholder={copy.idPlaceholder}
                description={copy.idDescription}
                variant="code"
                required
                {...idProblem?.kind === 'id' ? { error: idProblem.message } : {}}
                value={view.name}
                onValueChange={(next) => write(setName(text, next))}
              />
            {:else}
              <Input
                id="workflow-builder-name"
                label={copy.idLabel}
                placeholder={copy.idPlaceholder}
                description={copy.idChangedDescription.before}
                variant="code"
                required
                {...idProblem?.kind === 'id' ? { error: idProblem.message } : {}}
                value={view.name}
                onValueChange={(next) => write(setName(text, next))}
                trailing={resetIdAction}
                trailingInteractive
              >
                {#snippet descriptionAction()}
                  {' '}<code>{copy.idFile(view.name)}</code>{copy.idChangedDescription.after}
                {/snippet}
              </Input>
            {/if}
            {#if idProblem?.kind === 'id-taken'}
              {@const takenPath = workflowTypePath(view.name)}
              {@const at = idProblem.message.lastIndexOf(takenLink)}
              <p
                class="weft-workflow-builder__field-error"
                role="alert"
                data-testid="workflow-builder-id-taken"
              >
                {idProblem.message.slice(0, at)}<a
                  href={router.href(takenPath)}
                  onclick={(event) => go(event, takenPath)}>{takenLink}</a
                >{idProblem.message.slice(at + takenLink.length)}
              </p>
            {/if}
            <Textarea
              id="workflow-builder-description"
              label={copy.descriptionLabel}
              placeholder={copy.descriptionPlaceholder}
              rows={2}
              value={view.description}
              oninput={(event) => write(setDescription(text, event.currentTarget.value))}
            />
          </FormSection>

          <!-- One column: the trigger's choices, then its When block under them in the section's
               width, as run setup lays it out (rows 65d, 65q). -->
          <FormSection heading={copy.startsHeading} columns={1}>
            <SegmentedControl
              id="workflow-builder-trigger-kind"
              label={copy.triggerKindLabel}
              {...hiddenLabel}
              value={triggerValue}
              disabled={view.trigger?.kind === 'other' ||
                (view.trigger?.kind === 'contributed' && contributedTrigger === undefined)}
              onValueChange={(kind: string) => changeTriggerKind(kind)}
            >
              {#each triggerOptions as option (option.value)}
                <Segment value={option.value}>{option.label}</Segment>
              {/each}
            </SegmentedControl>
            {#if view.trigger?.kind === 'manual'}
              <p class="weft-workflow-builder__note" data-testid="workflow-builder-manual">
                {copy.manualHint}
              </p>
            {:else if view.trigger?.kind === 'signal'}
              <Input
                id="workflow-builder-trigger-field"
                label={copy.signalNameLabel}
                description={copy.signalNameDescription}
                variant="code"
                required
                {...errorOf('workflow-builder-trigger-field')}
                value={view.trigger.name}
                onValueChange={(next) => write(setTrigger(text, 'signal', next))}
              />
            {:else if view.trigger?.kind === 'contributed' && contributedTrigger !== undefined}
              <div class="weft-workflow-builder__contributed" data-testid="contributed-trigger">
                <p class="weft-workflow-builder__note">{contributedTrigger.description}</p>
                <ContributedConfigurationForm
                  kindId={contributedTrigger.id}
                  schema={contributedTrigger.configuration}
                  value={view.trigger.configuration}
                  hosted
                  onChange={(next) =>
                    write(setContributedTrigger(text, contributedTrigger.id, next))}
                />
              </div>
            {:else if view.trigger?.kind === 'contributed' && contributed.isPending}
              <p class="weft-workflow-builder__note" data-testid="contributed-trigger-loading">
                {copy.checkingTrigger(view.trigger.id)}
              </p>
            {:else if view.trigger?.kind === 'contributed' && contributed.isError}
              <div
                class="weft-workflow-builder__contributed"
                data-testid="contributed-trigger-error"
              >
                <p class="weft-workflow-builder__note" role="alert">
                  {copy.triggersFailed(view.trigger.id)}
                </p>
                <Button
                  variant="secondary"
                  onclick={() => void contributed.refetch()}
                  label={copy.retryTriggers}
                />
              </div>
            {:else if view.trigger?.kind === 'contributed'}
              <p class="weft-workflow-builder__note">
                {copy.unavailableTrigger(view.trigger.id)}
              </p>
            {:else if view.trigger?.kind === 'other'}
              <p class="weft-workflow-builder__note">{view.trigger.label}. {copy.otherTrigger}</p>
            {:else if view.trigger?.kind === 'schedule' && scheduleValue !== undefined}
              <!-- Repeats, At, Time zone, the next runs and the two policy selects (row 65q); what
                   they write is the file's spec, timezone, overlap and catchUp (row 65d). -->
              {@const trigger = view.trigger}
              <ScheduleWhen
                bind:this={scheduleWhen}
                value={scheduleValue}
                onValueChange={(next) => write(setScheduleFields(text, scheduleFieldsOf(next)))}
                label={copy.scheduleLabel}
                overlap={trigger.overlap ?? DEFAULT_OVERLAP}
                onOverlapChange={(next) => write(setScheduleFields(text, { overlap: next }))}
                catchUp={trigger.catchUp ?? false}
                onCatchUpChange={(next) => write(setScheduleFields(text, { catchUp: next }))}
                catchUpLabel={WORKFLOW_COPY.runSetup.catchUpLabel}
                fireZone
              />
              {#if mode === 'edit' && trigger.name !== null && trigger.name.trim() !== ''}
                <div data-testid="workflow-builder-schedule-note">
                  <Callout variant="info">{copy.scheduleDefinedNote(trigger.name.trim())}</Callout>
                </div>
              {/if}
            {:else if view.trigger?.kind === 'schedule'}
              <Input
                id="workflow-builder-trigger-field"
                label={copy.scheduleLabel}
                description={copy.scheduleDescription}
                variant="code"
                required
                {...errorOf('workflow-builder-trigger-field')}
                value={view.trigger.spec}
                onValueChange={(next) => write(setTrigger(text, 'schedule', next))}
              />
            {/if}
          </FormSection>

          <!-- One column: the steps and the Add a step under them are one list, not two grid cells. -->
          <FormSection heading={copy.stepsHeading} description={copy.stepsDescription} columns={1}>
            {#if !view.stepsEditable}
              <p
                class="weft-workflow-builder__note"
                data-testid="workflow-builder-steps-unreadable"
              >
                {copy.stepsUnreadable}
              </p>
            {:else}
              {#if view.steps.length === 0}
                <p class="weft-workflow-builder__note" data-testid="workflow-builder-no-steps">
                  {copy.noSteps}
                </p>
              {/if}
              <WorkflowStepList steps={view.steps} list={ROOT_LIST} address={ROOT_ADDRESS} />
            {/if}
          </FormSection>

          {@render schemaSection(
            'inputSchema',
            copy.inputHeading,
            copy.inputDescription,
            copy.inputEmpty,
          )}
          {@render schemaSection(
            'outputSchema',
            copy.outputHeading,
            copy.outputDescription,
            copy.outputEmpty,
          )}
        </div>
      {/if}
    </Tabs.Panel>

    <Tabs.Panel value="json">
      <div class="weft-workflow-builder__json" inert={locked}>
        <JsonEditor
          bind:this={jsonEditor}
          id={jsonId}
          label={jsonLabel}
          description={jsonDescription}
          rows={18}
          value={text}
          error={jsonError}
          invalidStatusLabel={copy.json.invalid}
          parserStopVisible={mode === 'edit'}
          {...notWorkflowMarks}
          onValueChange={onTextChange}
        />
      </div>
    </Tabs.Panel>
  </Tabs>

  {#if aboveFooter !== undefined}
    {@render aboveFooter()}
  {/if}

  {#if failure !== null}
    <Alert variant="danger">
      <p class="weft-workflow-builder__alert-title">{failure.title}</p>
      <p class="weft-workflow-builder__alert-body">
        {#if failure.message !== failure.title}{failure.message}{' '}{/if}<span
          >{WORKFLOW_COPY.creator.nothingSaved}</span
        >
      </p>
    </Alert>
  {/if}

  {#if summary !== undefined}
    <p
      class="weft-workflow-builder__problems"
      aria-live="polite"
      data-testid="workflow-builder-problems"
    >
      {summary}
    </p>
  {/if}

  <footer class="weft-workflow-builder__footer">
    <p
      id={READ_BACK_ID}
      class="weft-workflow-builder__read-back"
      data-truncated={summary !== undefined ? '' : undefined}
      data-testid="workflow-builder-summary"
    >
      {#if blocked}
        {fixLine}
      {:else if status !== undefined}
        {status}
      {:else}
        <span class="cinder-sr-only">{copy.readBack.label}: </span>{view?.readBack ?? ''}
      {/if}
    </p>
    {#if actions !== undefined}
      <div class="weft-workflow-builder__actions" inert={readOnly}>{@render actions(readOnly)}</div>
    {/if}
  </footer>
</div>

<style>
  .weft-workflow-builder {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-4);
    min-width: 0;
  }

  .weft-workflow-builder__body {
    display: flex;
    flex-direction: column;
    gap: 20px;
    padding-top: var(--cinder-space-3);
  }

  .weft-workflow-builder__tabs {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    column-gap: var(--cinder-space-2);
    align-items: center;
    min-width: 0;
  }

  .weft-workflow-builder__tabs :global(.cinder-tab-list) {
    inline-size: 100%;
    min-inline-size: 0;
  }

  .weft-workflow-builder__read-only {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    white-space: nowrap;
  }

  /* A read-only builder offers nothing to type: its fields show their values, never a prompt. */
  .weft-workflow-builder__body[data-read-only] :global(::placeholder) {
    color: transparent;
  }

  .weft-workflow-builder__notice {
    padding-top: var(--cinder-space-3);
  }

  .weft-workflow-builder__id-line {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: baseline;
    margin: 0;
  }

  .weft-workflow-builder__id-label {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .weft-workflow-builder__id {
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__field-error {
    margin: 0;
    color: var(--cinder-status-danger-text);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__problems {
    margin: 0;
    color: var(--cinder-status-danger-text);
    font-size: var(--cinder-text-sm);
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__schema-empty {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    justify-content: space-between;
    padding: var(--cinder-space-3);
    border: 1px dashed var(--cinder-border);
    border-radius: var(--cinder-radius-md);
  }

  .weft-workflow-builder__contributed {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    min-width: 0;
  }

  .weft-workflow-builder__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__footer {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-3);
    align-items: center;
    justify-content: space-between;
    padding-top: var(--cinder-space-3);
    border-top: 1px solid var(--cinder-border);
  }

  .weft-workflow-builder__read-back {
    flex: 1 1 16rem;
    margin: 0;
    min-width: 0;
    overflow-wrap: anywhere;
  }

  .weft-workflow-builder__read-back[data-truncated] {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .weft-workflow-builder__actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    margin-left: auto;
  }

  .weft-workflow-builder__alert-title {
    margin: 0;
    font-weight: 600;
  }

  .weft-workflow-builder__alert-body {
    margin: 4px 0 8px;
  }
</style>

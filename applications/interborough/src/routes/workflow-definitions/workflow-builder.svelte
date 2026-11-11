<script lang="ts">
  /**
   * The workflow builder, shared by `/workflows/new` and `/workflows/:workflow/edit` (board
   * PageWorkflowBuilder): a Builder tab (Title and the ID it makes, Description, Starts, the steps
   * as numbered cards, then Input and Output) and a JSON tab, over a footer that reads the whole
   * workflow back in one sentence beside the page's Cancel and primary action. The page owns the
   * file's text. The builder reads it and writes a changed copy back through `onTextChange`, and
   * the JSON tab edits the same text, so each view shows the other's edits and neither can lose
   * what the other wrote (`workflow-builder-model.ts`). Below 640 pixels the
   * builder is read-only (its fields, its JSON and its actions; the tabs still switch) and says to
   * open it on a larger screen, beside a link back (row 05n).
   *
   * Create workflow's problems (the ID, what starts it, each step) are said at their fields and
   * outline their step once the page asks to `showProblems`, from two of them in one line above the
   * footer, and `focusProblem()` takes the person to the first. Text that is not a JSON object is
   * the JSON tab's to fix: the Builder tab is off with the reason, and the footer says which line
   * to fix in place of the read-back.
   */
  import {
    Alert,
    Button,
    FormSection,
    Input,
    JsonEditor,
    JsonSchemaEditor,
    Segment,
    SegmentedControl,
    Select,
    Tabs,
    Textarea,
    type JsonSchemaValue,
  } from '@lostgradient/cinder';
  import { ArrowDown, ArrowUp, Plus, Trash2 } from '@lucide/svelte';
  import { createQuery } from '@tanstack/svelte-query';
  import { tick, untrack, type Snippet } from 'svelte';

  import { WORKFLOW_COPY } from '../../app/copy.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { readScheduleAttention } from '../../lib/bureau-attention.ts';
  import { listAgents } from '../../lib/bureau-client.ts';
  import { listContributedKinds } from '../../lib/bureau-plugin-kinds.ts';
  import ContributedConfigurationForm from '../../lib/contributed-configuration-form.svelte';
  import { phoneViewport } from '../../lib/phone-viewport.svelte.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { router } from '../../lib/router.svelte.ts';
  import { workflowTypePath } from '../../lib/workflow-type-paths.ts';
  import { loadModelAgents } from '../schedules/schedule-row-context.ts';
  import {
    addStep,
    identifierFromTitle,
    moveStep,
    readBuilder,
    removeStep,
    setContributedTrigger,
    setDescription,
    setName,
    setSchema,
    setStepField,
    setStepTitle,
    setTitle,
    setTitleDerivingName,
    setTrigger,
    setWaitDuration,
    WAIT_UNITS,
    type BuilderSchema,
    type BuilderStepKind,
    type SchemaKey,
    type WaitUnit,
  } from './workflow-builder-model.ts';
  import {
    problemSummary,
    stepFieldId,
    workflowProblems,
    type WorkflowProblem,
  } from './workflow-builder-problems.ts';
  import { locateJsonProblem } from './workflow-source.ts';

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
    /** Where the read-only notice below 640 pixels links back to: the workflow's page, or Workflows. */
    backHref: string;
    /** The footer's actions, at the right of the read-back: Cancel and the one primary action. */
    actions?: Snippet;
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
  }

  let {
    text,
    onTextChange,
    mode,
    error,
    jsonId,
    jsonLabel,
    jsonDescription,
    backHref,
    actions,
    showProblems = false,
    takenId,
    saving = false,
    failure = null,
  }: Props = $props();

  const copy = WORKFLOW_COPY.builder;
  const takenLink = WORKFLOW_COPY.creator.takenLink;

  /** The footer's sentence, which a disabled Builder tab points at as its reason. */
  const READ_BACK_ID = 'workflow-builder-read-back';

  // Text the builder cannot read opens on the JSON tab, where it is fixed.
  let tab = $state<'builder' | 'json'>(
    untrack(() => (readBuilder(text) === undefined ? 'json' : 'builder')),
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

  const view = $derived(
    readBuilder(text, { agentName: (identifier) => agentLabel(identifier, agents.data) }),
  );

  /**
   * The builder cannot draw text that is not a JSON object, so its tab is off with the reason and
   * the JSON tab holds the fix. `jsonProblem` is where the text stops being JSON, or `null` when it
   * parses but is not an object.
   */
  const blocked = $derived(view === undefined);
  const jsonProblem = $derived(blocked ? locateJsonProblem(text) : null);
  const fixLine = $derived(copy.json.fixLine(jsonProblem?.line ?? 1));
  /** Valid JSON that is not an object: the editor marks its first line and says so in its status. */
  const notWorkflow = $derived(blocked && jsonProblem === null && text.trim() !== '');

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
  /** Whether a step has something to fix, which outlines its card. */
  function stepHasProblem(position: number): boolean {
    return visible.some((problem) => problem.position === position);
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
    if (blocked) {
      tab = 'json';
      await tick();
      jsonEditor?.focusProblem();
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

  /** The agents the steps name, each once and in order, for the provider check. */
  const namedAgents = $derived(
    [
      ...new Set(
        (view?.steps ?? []).flatMap((step) =>
          step.kind === 'agent' && step.agent !== '' ? [step.agent] : [],
        ),
      ),
    ].sort(),
  );

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

  const ADD_ACTIONS: readonly { kind: BuilderStepKind; label: string }[] = [
    { kind: 'agent', label: copy.add.agent },
    { kind: 'person', label: copy.add.person },
    { kind: 'signal', label: copy.add.signal },
    { kind: 'wait', label: copy.add.wait },
  ];

  const UNIT_OPTIONS = WAIT_UNITS.map((unit) => ({ value: unit, label: copy.units[unit] }));

  function changeTriggerKind(kind: string): void {
    if (kind === 'manual' || kind === 'schedule' || kind === 'signal') {
      onTextChange(setTrigger(text, kind, ''));
    } else if (triggers.some((candidate) => candidate.id === kind)) {
      onTextChange(setContributedTrigger(text, kind, {}));
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
    onTextChange(mode === 'create' ? setTitleDerivingName(text, next) : setTitle(text, next));
  }

  function useDerivedId(): void {
    onTextChange(setName(text, derivedId));
    idOpen = false;
  }

  /** The agents a step's select offers: the catalog, and the one the file names when it is not there. */
  function agentOptions(current: string): { value: string; label: string; disabled?: boolean }[] {
    const catalog = agents.data ?? [];
    return [
      { value: '', label: copy.agentPlaceholder, disabled: true },
      ...(current !== '' && !catalog.some((agent) => agent.name === current)
        ? [{ value: current, label: agentLabel(current, catalog) }]
        : []),
      ...catalog.map((agent) => ({ value: agent.name, label: agentLabel(agent.name, catalog) })),
    ];
  }

  /** What "Add a field" opened: an empty schema shown in the editor, not yet written to the file. */
  let schemaOpened = $state<Record<SchemaKey, boolean>>({
    inputSchema: false,
    outputSchema: false,
  });

  /** The schema an opened, still empty Input or Output starts from. */
  const EMPTY_SCHEMA: Readonly<Record<string, unknown>> = { type: 'object', properties: {} };

  const NO_SCHEMA: BuilderSchema = { kind: 'none' };

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
    onTextChange(setSchema(text, key, record));
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
  <FormSection {heading} {description}>
    {#if schema.kind === 'unreadable'}
      <p class="weft-workflow-builder__note">{copy.schemaUnreadable}</p>
    {:else if schema.kind === 'none' && !schemaOpened[key]}
      <div
        class="weft-workflow-builder__schema-empty"
        data-testid={`workflow-builder-${key}-empty`}
      >
        <p class="weft-workflow-builder__note">{empty}</p>
        <Button variant="secondary" size="sm" onclick={() => (schemaOpened[key] = true)}>
          {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
          {copy.addField}
        </Button>
      </div>
    {:else}
      <JsonSchemaEditor
        id={`workflow-builder-${key}`}
        schema={shownSchema(schema)}
        onValueChangeRequest={(event) => changeSchema(key, event.schema)}
      />
    {/if}
  </FormSection>
{/snippet}

<div class="weft-workflow-builder" data-testid="workflow-builder">
  {#if readOnly}
    <p class="weft-workflow-builder__phone" data-testid="workflow-builder-phone">
      <span>{copy.phone.message}</span>
      <Button
        variant="ghost-accent"
        size="sm"
        href={router.href(backHref)}
        onclick={(event) => go(event, backHref)}
        >{mode === 'create' ? copy.phone.backToWorkflows : copy.phone.backToWorkflow}</Button
      >
    </p>
  {/if}

  <Tabs bind:value={tab}>
    <Tabs.List label={copy.tabsLabel}>
      <Tabs.Trigger
        value="builder"
        disabled={blocked}
        {...blocked ? { 'aria-describedby': READ_BACK_ID } : {}}>{copy.builderTab}</Tabs.Trigger
      >
      <Tabs.Trigger value="json">{copy.jsonTab}</Tabs.Trigger>
    </Tabs.List>

    <Tabs.Panel value="builder">
      {#if view !== undefined}
        {#if error !== ''}
          <Alert variant="danger">{error}</Alert>
        {/if}

        <div class="weft-workflow-builder__body" inert={locked}>
          <FormSection>
            <Input
              id="workflow-builder-title"
              label={copy.titleLabel}
              placeholder={copy.titlePlaceholder}
              value={view.title}
              onValueChange={changeTitle}
            />
            {#if mode === 'edit'}
              <Input
                id="workflow-builder-name"
                label={copy.idLabel}
                description={copy.idFixed}
                variant="code"
                readonly
                value={view.name}
              />
            {:else if idCollapsed}
              <p class="weft-workflow-builder__id-line" data-testid="workflow-builder-id-line">
                <span class="weft-workflow-builder__id-label">{copy.idLabel}</span>
                <code class="weft-workflow-builder__id">{view.name}</code>
                <Button variant="ghost-accent" size="sm" onclick={() => (idOpen = true)}
                  >{copy.idChange}</Button
                >
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
                onValueChange={(next) => onTextChange(setName(text, next))}
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
                onValueChange={(next) => onTextChange(setName(text, next))}
              >
                {#snippet descriptionAction()}
                  {' '}<code>{copy.idFile(view.name)}</code>{copy.idChangedDescription.after}
                  <Button variant="ghost-accent" size="sm" onclick={useDerivedId}
                    >{copy.useDerivedId}</Button
                  >
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
              oninput={(event) => onTextChange(setDescription(text, event.currentTarget.value))}
            />
          </FormSection>

          <FormSection heading={copy.startsHeading}>
            <SegmentedControl
              id="workflow-builder-trigger-kind"
              label={copy.triggerKindLabel}
              labelVisible={false}
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
                onValueChange={(next) => onTextChange(setTrigger(text, 'signal', next))}
              />
            {:else if view.trigger?.kind === 'contributed' && contributedTrigger !== undefined}
              <div class="weft-workflow-builder__contributed" data-testid="contributed-trigger">
                <p class="weft-workflow-builder__note">{contributedTrigger.description}</p>
                <ContributedConfigurationForm
                  kindId={contributedTrigger.id}
                  schema={contributedTrigger.configuration}
                  value={view.trigger.configuration}
                  onChange={(next) =>
                    onTextChange(setContributedTrigger(text, contributedTrigger.id, next))}
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
                <Button variant="secondary" onclick={() => void contributed.refetch()}>
                  {copy.retryTriggers}
                </Button>
              </div>
            {:else if view.trigger?.kind === 'contributed'}
              <p class="weft-workflow-builder__note">
                {copy.unavailableTrigger(view.trigger.id)}
              </p>
            {:else if view.trigger?.kind === 'other'}
              <p class="weft-workflow-builder__note">{view.trigger.label}. {copy.otherTrigger}</p>
            {:else if view.trigger?.kind === 'schedule'}
              <Input
                id="workflow-builder-trigger-field"
                label={copy.scheduleLabel}
                description={copy.scheduleDescription}
                variant="code"
                required
                {...errorOf('workflow-builder-trigger-field')}
                value={view.trigger.spec}
                onValueChange={(next) => onTextChange(setTrigger(text, 'schedule', next))}
              />
            {/if}
          </FormSection>

          <FormSection heading={copy.stepsHeading} description={copy.stepsDescription}>
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
              {:else}
                <ol class="weft-workflow-builder__cards">
                  {#each view.steps as step, index (index)}
                    {@const position = index + 1}
                    {@const id = `workflow-builder-step-${String(position)}`}
                    <li
                      class="weft-workflow-builder__card"
                      data-step-kind={step.kind}
                      data-problem={stepHasProblem(position) ? '' : undefined}
                    >
                      <div class="weft-workflow-builder__card-head">
                        <span class="weft-workflow-builder__position">{position}</span>
                        <span class="weft-workflow-builder__kind">{copy.stepKinds[step.kind]}</span>
                        <span class="weft-workflow-builder__card-actions">
                          {#if index > 0}
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={copy.moveEarlier(position)}
                              onclick={() => onTextChange(moveStep(text, index, -1))}
                              ><ArrowUp aria-hidden="true" /></Button
                            >
                          {/if}
                          {#if index < view.steps.length - 1}
                            <Button
                              variant="ghost"
                              size="sm"
                              aria-label={copy.moveLater(position)}
                              onclick={() => onTextChange(moveStep(text, index, 1))}
                              ><ArrowDown aria-hidden="true" /></Button
                            >
                          {/if}
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={copy.remove(position)}
                            onclick={() => onTextChange(removeStep(text, index))}
                            ><Trash2 aria-hidden="true" /></Button
                          >
                        </span>
                      </div>
                      {#if step.kind === 'other'}
                        <p class="weft-workflow-builder__other">{step.label}</p>
                        <p class="weft-workflow-builder__note">{copy.otherStepNote}</p>
                      {:else}
                        <Input
                          id={`${id}-title`}
                          label={copy.stepNameLabel}
                          aria-label={copy.stepName(position)}
                          placeholder={copy.stepKinds[step.kind]}
                          size="sm"
                          value={step.title}
                          onValueChange={(next) => onTextChange(setStepTitle(text, index, next))}
                        />
                      {/if}
                      {#if step.kind === 'agent'}
                        {#if agents.isError}
                          <Input
                            id={`${id}-agent`}
                            label={copy.agentFieldLabel}
                            aria-label={copy.agentLabel(position)}
                            placeholder={copy.agentPlaceholder}
                            size="sm"
                            variant="code"
                            required
                            {...errorOf(stepFieldId(position, 'agent'))}
                            value={step.agent}
                            onValueChange={(next) =>
                              onTextChange(setStepField(text, index, 'agent', next))}
                          />
                        {:else}
                          <Select
                            id={`${id}-agent`}
                            label={copy.agentFieldLabel}
                            aria-label={copy.agentLabel(position)}
                            size="sm"
                            required
                            {...errorOf(stepFieldId(position, 'agent'))}
                            value={step.agent}
                            options={agentOptions(step.agent)}
                            {...blockedAgents.has(step.agent)
                              ? { description: copy.needsProvider }
                              : {}}
                            onValueChange={(next: string) =>
                              onTextChange(setStepField(text, index, 'agent', next))}
                          />
                        {/if}
                        <Textarea
                          id={`${id}-message`}
                          label={copy.messageFieldLabel}
                          aria-label={copy.messageLabel(position)}
                          placeholder={copy.messagePlaceholder}
                          size="sm"
                          rows={3}
                          required
                          {...errorOf(stepFieldId(position, 'message'))}
                          value={step.message}
                          oninput={(event) =>
                            onTextChange(
                              setStepField(text, index, 'message', event.currentTarget.value),
                            )}
                        />
                      {:else if step.kind === 'person'}
                        <p class="weft-workflow-builder__note">{copy.personDescription}</p>
                      {:else if step.kind === 'signal'}
                        <Input
                          id={`${id}-signal`}
                          label={copy.signalFieldLabel}
                          aria-label={copy.signalLabel(position)}
                          placeholder={copy.signalPlaceholder}
                          description={copy.signalDescription}
                          size="sm"
                          variant="code"
                          required
                          {...errorOf(stepFieldId(position, 'signal'))}
                          value={step.signal}
                          onValueChange={(next) =>
                            onTextChange(setStepField(text, index, 'signal', next))}
                        />
                      {:else if step.kind === 'wait' && step.parts !== null}
                        {@const parts = step.parts}
                        <div class="weft-workflow-builder__wait">
                          <Input
                            id={`${id}-duration`}
                            label={copy.amountFieldLabel}
                            aria-label={copy.durationLabel(position)}
                            type="number"
                            min="0"
                            size="sm"
                            required
                            {...errorOf(stepFieldId(position, 'duration'))}
                            value={parts.amount}
                            onValueChange={(next) =>
                              onTextChange(setWaitDuration(text, index, next, parts.unit))}
                          />
                          <Select
                            id={`${id}-unit`}
                            label={copy.unitFieldLabel}
                            aria-label={copy.unitLabel(position)}
                            size="sm"
                            required
                            value={parts.unit}
                            options={UNIT_OPTIONS}
                            onValueChange={(unit: WaitUnit) =>
                              onTextChange(setWaitDuration(text, index, parts.amount, unit))}
                          />
                        </div>
                      {:else if step.kind === 'wait'}
                        <Input
                          id={`${id}-duration`}
                          label={copy.durationFieldLabel}
                          aria-label={copy.durationLabel(position)}
                          description={copy.durationDescription}
                          size="sm"
                          variant="code"
                          required
                          value={step.duration}
                          onValueChange={(next) =>
                            onTextChange(setStepField(text, index, 'duration', next))}
                        />
                      {/if}
                    </li>
                  {/each}
                </ol>
              {/if}
              <div class="weft-workflow-builder__add" role="group" aria-label={copy.addLabel}>
                <span class="weft-workflow-builder__add-label" aria-hidden="true"
                  >{copy.addLabel}</span
                >
                {#each ADD_ACTIONS as action (action.kind)}
                  <Button
                    id={`workflow-builder-add-${action.kind}`}
                    variant="secondary"
                    size="sm"
                    onclick={() => onTextChange(addStep(text, action.kind))}
                  >
                    {#snippet leadingIcon()}<Plus aria-hidden="true" />{/snippet}
                    {action.label}
                  </Button>
                {/each}
              </div>
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
          {...notWorkflow
            ? {
                statusLabel: copy.json.notWorkflow,
                diagnostics: [{ line: 1, message: copy.json.notObject }],
              }
            : {}}
          onValueChange={onTextChange}
        />
      </div>
    </Tabs.Panel>
  </Tabs>

  {#if failure !== null}
    <Alert variant="danger">
      <p class="weft-workflow-builder__alert-title">{failure.title}</p>
      <p class="weft-workflow-builder__alert-body">
        {#if failure.message !== failure.title}{failure.message}
        {/if}<span>{WORKFLOW_COPY.creator.nothingSaved}</span>
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
      {:else}
        <span class="cinder-sr-only">{copy.readBack.label}: </span>{view?.readBack ?? ''}
      {/if}
    </p>
    {#if actions !== undefined}
      <div class="weft-workflow-builder__actions" inert={readOnly}>{@render actions()}</div>
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

  .weft-workflow-builder__phone {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
    align-items: center;
    margin: var(--cinder-space-3) 0 0;
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

  .weft-workflow-builder__cards {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .weft-workflow-builder__card {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-2);
    padding: var(--cinder-space-3);
    border: 1px solid var(--cinder-border);
    border-radius: var(--cinder-radius-md);
    min-width: 0;
  }

  /* A step with something to fix is outlined, so it is found without reading its fields. */
  .weft-workflow-builder__card[data-problem] {
    border-color: var(--cinder-status-danger-border);
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

  .weft-workflow-builder__card-head {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: center;
  }

  .weft-workflow-builder__position {
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
    font-variant-numeric: tabular-nums;
  }

  .weft-workflow-builder__kind {
    flex: 1 1 auto;
    font-weight: 600;
    min-width: 0;
  }

  .weft-workflow-builder__card-actions,
  .weft-workflow-builder__add {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-1);
    align-items: center;
  }

  .weft-workflow-builder__add {
    margin-top: var(--cinder-space-2);
  }

  .weft-workflow-builder__add-label {
    margin-right: var(--cinder-space-1);
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-xs);
  }

  .weft-workflow-builder__wait {
    display: flex;
    flex-wrap: wrap;
    gap: var(--cinder-space-2);
  }

  .weft-workflow-builder__wait > :global(*) {
    flex: 1 1 8rem;
    min-width: 0;
  }

  .weft-workflow-builder__other {
    margin: 0;
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

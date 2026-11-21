<script lang="ts">
  /**
   * The Settings tab of an agent's page (board PageAgent, rows 38u to 39b, 39s, 39t and 39u).
   *
   * For an agent file the owner keeps it is a form: the Model section with the model and its
   * provider, grouped by provider, and, while that provider holds no key, why the agent cannot
   * answer with a way to connect one (row 38u); the models a chat may change to, as chips with Add
   * a model; the effort a chat starts at; and the step limit (row 38v). One Save changes writes them
   * as the next version, which the note under the buttons names, and Discard puts the form back
   * (row 38w). A step limit that is not a whole number from 1 to 100 is refused at the field when the
   * form is submitted, and the field takes focus; nothing is written (row 39s). Guardrails, spend
   * and tool limits, and tool approvals are on the Access tab.
   *
   * Only this tab has a Save, so only it asks before it is left with changes that are not saved: a
   * tab switch, a link, back or forward, or closing the window (row 39b, `LeaveGuard`). Discard and
   * leave goes to the tab that was chosen with the page kept mounted.
   *
   * Under the form are the saved versions (`agent-versions.svelte`), where View opens one
   * read-only in the form's place, and last a demoted Delete agent, which asks first with the
   * agent's identifier typed to confirm and names what stops finding it (row 39a).
   *
   * An agent defined in code that the page can change (a built-in agent, or a running plugin's,
   * COR-2229) is the same form, with an Instructions section first, saved by the same Save changes
   * as a version of the agent's overrides (`agent-overrides.ts`) and listed with Restore in the
   * same versions list; it has no Delete, because Restore is the way back. A plugin's agent that is
   * a file, or whose plugin is disabled, shows its model and the models a chat may be switched to
   * read-only, with no Delete and no versions, and says why in one line.
   *
   * An agent defined in code ends the tab with Disable this agent (row 38y): Disable agent asks
   * first, naming the chats that stay and what stops finding it, with no typed confirmation because
   * it is reversible (row 40d), and once the agent is disabled Enable agent takes its place.
   *
   * Every write names the hash of the file the page read, so a file that changed since is refused
   * instead of overwritten, and the page says so. A read of the file that lands while the form
   * holds changes never overwrites them. The tab bar names the tab, so the body repeats no heading
   * of its own (sweep S51), and the page's frame says when the agent is still being read or could
   * not be (`agent-tab-state.svelte`).
   */
  import { tick, untrack } from 'svelte';

  import {
    Alert,
    Badge,
    Button,
    Callout,
    Chip,
    ConfirmDialog,
    Input,
    SectionHeading,
    Select,
    Skeleton,
    Textarea,
    type SelectOption,
  } from '@lostgradient/cinder';
  import { createMutation, createQuery, useQueryClient } from '@tanstack/svelte-query';

  import { AGENT_EDITOR_COPY, AGENT_PAGE_COPY, EFFORT_LABELS } from '../../app/copy/agents.ts';
  import { hasToastHost, showToast } from '../../app/toast-host.svelte';
  import {
    agentFaultOf,
    DEFAULT_STEP_LIMIT,
    deleteAgent,
    disableAgent,
    EFFORTS,
    enableAgent,
    getAgentCatalog,
    listAgentReferences,
    listAgentVersions,
    updateAgent,
    type AgentDefinitionInput,
    type AgentDetail,
    type AgentFault,
    type Effort,
  } from '../../lib/agent-definitions.ts';
  import { agentLabel } from '../../lib/agent-label.ts';
  import { AGENT_TABS, agentTabPath, pluginOfAgent } from '../../lib/agent-paths.ts';
  import { getProviders } from '../../lib/host-providers.ts';
  import { keyedByOccurrence } from '../../lib/list-keys.ts';
  import { queryKeys } from '../../lib/query.ts';
  import { LeaveGuard, router } from '../../lib/router.svelte.ts';
  import {
    abilitiesOf,
    abilitiesSentence,
    modelGroups,
    NO_RESTRICTIONS,
  } from '../agent-editor/agent-editor-models.ts';
  import { providerDisplayName } from '../settings/models/format-model.ts';
  import type { OverridesWriter } from './agent-overrides.ts';
  import AgentDeleteDialog from './agent-delete-dialog.svelte';
  import AgentPluginNote from './agent-plugin-note.svelte';
  import AgentVersions from './agent-versions.svelte';
  import {
    changedParts,
    dependentsLine,
    effortChoices,
    modelLineOf,
    modelName,
    providerOf,
    settingsDefinition,
    settingsFormOf,
    settingsOf,
    stepLimitError,
    type SettingsForm,
  } from './agent-settings.ts';

  interface Props {
    /** The agent's identifier. */
    id: string;
    /** The agent as the Bureau shows it, once read. */
    detail: AgentDetail | undefined;
    /** The agent's name as a person reads it, which the provider reason and the delete question say. */
    name: string;
    /** How many chats were had with the agent, which the delete question says stay; `undefined` until known. */
    chats?: number | undefined;
    /** The plugin's title, as Settings › Plugins shows it, for the line that names the plugin. */
    pluginTitle?: string;
    /** Whether the agent's plugin is disabled, so the tab is read-only and says why. */
    unavailable?: boolean;
    /**
     * Set for a code agent the page changes (COR-2229): `detail` is then its definition with the
     * overrides applied, and a save is written through `write` as a version of the overrides.
     */
    overrides?:
      | {
          readonly write: OverridesWriter;
          readonly ownTools: readonly string[];
        }
      | undefined;
  }

  let {
    id,
    detail,
    name,
    chats,
    pluginTitle = '',
    unavailable = false,
    overrides,
  }: Props = $props();

  const copy = AGENT_PAGE_COPY.settings;
  const queryClient = useQueryClient();
  const toasts = hasToastHost();
  const STEP_LIMIT_ID = 'agent-settings-step-limit';
  const SETTINGS_MODELS_PATH = '/settings/models';

  const plugin = $derived(pluginOfAgent(id));
  const isFile = $derived(detail?.source === 'file');
  const hash = $derived(detail?.hash ?? null);
  /**
   * An agent file the owner keeps, that loaded: a form, Delete and versions; or a code agent the
   * page changes through overrides: the form and versions, no Delete. A plugin's file is read-only.
   */
  const writable = $derived(
    isFile &&
      (plugin === null || overrides !== undefined) &&
      detail?.definition != null &&
      detail.hash !== null,
  );
  const settings = $derived(detail === undefined ? undefined : settingsOf(detail));

  // What the Model field offers. A failure offers the model the file names alone, and the form
  // still saves the rest.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      enabled: writable,
      retry: false,
    }),
    undefined,
  );
  // Which providers hold a key, for the reason beside a model whose provider holds none (row 38u).
  const providers = createQuery(
    () => ({
      queryKey: queryKeys.hostProviders(),
      queryFn: ({ signal }) => getProviders({ signal }),
      enabled: writable,
      retry: false,
    }),
    undefined,
  );
  // The newest version, for the one a save makes (row 38w). The versions list shares the query.
  const versions = createQuery(
    () => ({
      queryKey: queryKeys.agents.versions(id),
      queryFn: ({ signal }) => listAgentVersions(id, { signal }),
      enabled: writable,
      retry: false,
    }),
    undefined,
  );
  const nextVersion = $derived(
    versions.data === undefined ? null : (versions.data[0]?.revision ?? 0) + 1,
  );

  // ── The form ─────────────────────────────────────────────────────────────────────────────────

  /** What the form was filled with, or last saved: what counts as no change. */
  let baseline = $state<SettingsForm | undefined>();
  let model = $state('');
  let models = $state<string[]>([]);
  let effort = $state<Effort | ''>('');
  let stepLimit = $state('');
  let instructions = $state('');
  /** Set by a submit: from then on the step limit says at its field why it cannot be saved. */
  let attempted = $state(false);
  /** The hash of the file the form was filled from, or last saved as. */
  let seededHash: string | null = null;

  const form = $derived<SettingsForm>({ model, models, effort, stepLimit, instructions });
  const changed = $derived(baseline === undefined ? [] : changedParts(baseline, form));
  const dirty = $derived(changed.length > 0);
  const stepError = $derived(attempted ? stepLimitError(stepLimit, baseline?.stepLimit) : '');

  function fill(next: SettingsForm, at: string | null): void {
    baseline = next;
    model = next.model;
    models = [...next.models];
    effort = next.effort;
    stepLimit = next.stepLimit;
    instructions = next.instructions;
    attempted = false;
    seededHash = at;
  }

  // A code agent's override hash can arrive before the definition that supplies restored values.
  // Refill when either changes, while leaving a draft or an in-flight save alone.
  $effect(() => {
    const loaded = detail;
    if (!writable || loaded === undefined) return;
    const definition = loaded.definition;
    const at = loaded.hash;
    if (definition === null) return;
    const next = settingsFormOf(definition);
    untrack(() => {
      if (dirty || save.isPending) return;
      if (baseline !== undefined && at === seededHash && changedParts(baseline, next).length === 0)
        return;
      fill(next, at);
    });
  });

  /** Puts the form back as the file now has it, taking up a file that moved while it held changes. */
  function discard(): void {
    const definition = detail?.definition ?? null;
    if (definition !== null) fill(settingsFormOf(definition), detail?.hash ?? null);
  }

  // ── The Model section ────────────────────────────────────────────────────────────────────────

  const groups = $derived(
    catalog.data === undefined
      ? []
      : modelGroups(catalog.data, providers.data?.providers, NO_RESTRICTIONS, undefined),
  );
  /** The catalog's row of the model the form holds, for its abilities and its efforts. */
  const modelRow = $derived(
    groups.flatMap((group) => group.choices).find((choice) => choice.value === model)?.row,
  );

  /** The models the Model field offers, grouped by provider, with the one the form holds always listed. */
  const modelOptions = $derived.by((): SelectOption[] => {
    const offered = groups.flatMap((group) =>
      group.choices.map((choice): SelectOption => ({
        value: choice.value,
        label: modelName(choice.value),
        group: providerDisplayName(group.provider),
        ...(choice.unavailable === undefined
          ? {}
          : {
              disabled: true,
              description: AGENT_EDITOR_COPY.model.reasons[choice.unavailable],
            }),
      })),
    );
    // An agent that names no model, such as a scripted one, shows it as such.
    return offered.some((option) => option.value === model)
      ? offered
      : [{ value: model, label: model === '' ? copy.modelNone : modelName(model) }, ...offered];
  });

  /**
   * The catalog's own row of the model, when the field offers none: a provider whose key is not
   * saved keeps its rows in the catalog, `unavailable` (COR-2143), and the field leaves them out,
   * but what the model can do is still known from its row (row 38u, design review 2). Found by its
   * identifier or by one of its aliases (`anthropic/sonnet`).
   */
  const ownRow = $derived(
    modelRow ??
      catalog.data?.models.find(
        (row) =>
          `${row.provider}/${row.model}` === model ||
          row.aliases.some((entry) => `${row.provider}/${entry.alias}` === model),
      ),
  );

  /** What the chosen model can do, in one muted line, connected or not. */
  const abilityLine = $derived.by(() => {
    if (ownRow === undefined) return '';
    const words = AGENT_EDITOR_COPY.model;
    const abilities = abilitiesOf(ownRow);
    // As a sentence reads: "Tools, images, streaming, 1M context window" (design review 3).
    return abilitiesSentence([
      ...abilities.has.map((ability) => words.abilities[ability]),
      words.context(abilities.context),
    ]);
  });

  /** The provider of the model, when the host says it holds no key (row 38u). */
  const unconnected = $derived.by(() => {
    const provider = providerOf(model);
    const known = providers.data?.providers;
    if (provider === '' || known === undefined) return undefined;
    return known.some((entry) => entry.name === provider && entry.connected)
      ? undefined
      : providerDisplayName(provider);
  });

  /** The models Add a model offers: every model offered that a chat cannot change to yet. */
  const addOptions = $derived<SelectOption[]>([
    { value: '', label: copy.addModel },
    ...modelOptions.filter(
      (option) => option.value !== model && !models.includes(option.value) && !option.disabled,
    ),
  ]);

  function addModel(next: string): string {
    if (next !== '' && !models.includes(next)) models = [...models, next];
    return '';
  }

  function removeModel(removed: string): void {
    models = models.filter((entry) => entry !== removed);
  }

  const efforts = $derived(effortChoices(modelRow?.effort.portable, effort));
  /** None, then the tiers the model supports, as the agent editor's select lists them. */
  const effortOptions = $derived([
    { value: '', label: AGENT_EDITOR_COPY.effort.none },
    ...efforts.map((choice) => ({ value: choice, label: EFFORT_LABELS[choice] })),
  ]);

  function chooseEffort(next: string): void {
    effort = EFFORTS.find((entry) => entry === next) ?? '';
  }

  /** Follows a link in the app's router, unless the click asks for a new tab. */
  function openSettings(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(SETTINGS_MODELS_PATH);
  }

  // ── Save, and what refuses a write ───────────────────────────────────────────────────────────

  let problem = $state<string | null>(null);

  function refuse(fault: AgentFault, failure: string): void {
    switch (fault.kind) {
      case 'stale':
        problem = copy.stale;
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.agents.overrides(id) });
        return;
      case 'forbidden':
        problem = copy.forbidden;
        return;
      case 'rejected':
      case 'other':
        problem = fault.message;
        return;
      case 'not-found':
      case 'identifier-taken':
        problem = failure;
        return;
    }
  }

  const save = createMutation(() => ({
    mutationFn: (input: {
      readonly expectedHash: string;
      readonly definition: AgentDefinitionInput;
      readonly form: SettingsForm;
      readonly filled: AgentDefinitionInput;
    }) =>
      // A code agent's save is a version of its overrides; an agent file's is a write to the file.
      overrides === undefined
        ? updateAgent(id, input.expectedHash, input.definition)
        : overrides.write(input.expectedHash, input.definition, input.filled),
    onMutate: () => {
      problem = null;
    },
    onSuccess: (result, input) => {
      // What was saved is now no change, under the hash the save returned.
      baseline = input.form;
      seededHash = result.hash;
      attempted = false;
      if (toasts) showToast(copy.saved(nextVersion), { variant: 'success' });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.overrides(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.versions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.revisions(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
    },
    onError: (error) => refuse(agentFaultOf(error), copy.saveFailed),
  }));

  /** Moves focus to the step limit, once the message a submit shows is on the page. */
  async function focusStepLimit(): Promise<void> {
    await tick();
    document.getElementById(STEP_LIMIT_ID)?.focus();
  }

  function submit(event: SubmitEvent): void {
    event.preventDefault();
    attempted = true;
    if (stepLimitError(stepLimit, baseline?.stepLimit) !== '') {
      // Nothing is written; the field says why and takes focus (row 39s).
      void focusStepLimit();
      return;
    }
    // The write names the hash the form was filled from, so a file that moved while the form held
    // changes is refused instead of overwritten. The rest of the definition is the file's as read.
    const definition = detail?.definition ?? null;
    const expectedHash = seededHash;
    if (!dirty || definition === null || expectedHash === null || save.isPending) return;
    const snapshot: SettingsForm = { model, models: [...models], effort, stepLimit, instructions };
    save.mutate({
      expectedHash,
      definition: settingsDefinition(definition, snapshot),
      // What the form was filled with, or last saved, as a write: the part of the write that is no change.
      filled: settingsDefinition(definition, baseline ?? snapshot),
      form: snapshot,
    });
  }

  // ── Leaving with changes ─────────────────────────────────────────────────────────────────────

  const guard = new LeaveGuard(() => dirty);
  $effect(() => guard.attach());

  /** Whether `destination` is another tab of this agent's page, which keeps the page mounted. */
  function isOwnTab(destination: string | undefined): boolean {
    const path = destination?.split('?')[0];
    return AGENT_TABS.some((tab) => agentTabPath(id, tab) === path);
  }

  // ── Delete ───────────────────────────────────────────────────────────────────────────────────

  let confirmingDelete = $state(false);
  let deleteError = $state<string | undefined>();

  const removal = createMutation(() => ({
    mutationFn: (expectedHash: string) => deleteAgent(id, expectedHash),
    onMutate: () => {
      problem = null;
      deleteError = undefined;
    },
    onSuccess: () => {
      confirmingDelete = false;
      guard.release();
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      router.navigate('/agents');
    },
    onError: (error) => {
      const fault = agentFaultOf(error);
      if (fault.kind === 'rejected' || fault.kind === 'other') {
        deleteError = fault.message;
        return;
      }
      confirmingDelete = false;
      refuse(fault, copy.deleteFailed);
    },
  }));

  function confirmDelete(): void {
    if (hash !== null) removal.mutate(hash);
  }

  // ── Disable and enable (rows 38y and 40d) ────────────────────────────────────────────────────

  /** An agent defined in code can be disabled but not deleted; a disabled plugin's runs nothing already. */
  // A code agent the page changes arrives shaped as a file (`overridableDetail`), with `overrides` set.
  const disableable = $derived(
    (detail?.source === 'code' || overrides !== undefined) && !unavailable,
  );
  const disabled = $derived(detail?.state === 'disabled');
  /** The agent's name as the agents list says it ("Tool runner"), for the Disable block and question. */
  const shownName = $derived(agentLabel(name, undefined));
  let confirmingDisable = $state(false);

  // What finds the agent, read once the disable question opens: the same read the delete question uses.
  const disableReferences = createQuery(
    () => ({
      queryKey: queryKeys.agents.references(id),
      queryFn: ({ signal }) => listAgentReferences(id, { signal }),
      enabled: confirmingDisable,
      retry: false,
    }),
    undefined,
  );

  const toggle = createMutation(() => ({
    mutationFn: (next: 'disable' | 'enable') =>
      next === 'disable' ? disableAgent(id) : enableAgent(id),
    onMutate: () => {
      problem = null;
    },
    onSuccess: () => {
      confirmingDisable = false;
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definition(id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.definitions() });
      void queryClient.invalidateQueries({ queryKey: queryKeys.agents.list() });
    },
    onError: (error, next) =>
      refuse(
        agentFaultOf(error),
        next === 'disable' ? copy.disable.failed : copy.disable.enableFailed,
      ),
  }));

  /** The version open read-only in the form's place, or `null` while the form shows. */
  let viewing = $state<number | null>(null);

  // hidden-label-allowed: the Model section heading and the fallback models label above each select are their visible labels
  const hiddenLabel = { labelVisible: false } as const;
</script>

<div class="ib-agent-settings" data-testid="agent-settings">
  {#if settings === undefined || detail === undefined}
    <div role="status" aria-busy="true" aria-label={copy.heading}>
      <Skeleton height="8rem" />
    </div>
  {:else}
    {#if problem !== null}
      <Alert variant="danger" dismissible onDismiss={() => (problem = null)}>
        <p>{problem}</p>
      </Alert>
    {/if}

    {#if !writable}
      <section class="ib-agent-section" aria-label={copy.heading}>
        {#if plugin !== null}
          <AgentPluginNote
            {plugin}
            title={pluginTitle}
            mode={unavailable ? 'unavailable' : 'read-only'}
          />
        {:else if !isFile && !disabled}
          <p class="ib-agent-note" data-testid="agent-built-in">{copy.builtIn}</p>
        {/if}
        <dl class="ib-agent-settings__list">
          <div class="ib-agent-settings__row">
            <dt>{copy.modelLabel}</dt>
            <dd>
              {#if settings.model === null}{copy.notSet}{:else}<span title={settings.model}
                  >{modelLineOf(settings.model)}</span
                >{/if}
            </dd>
          </div>
          <div class="ib-agent-settings__row">
            <dt>{copy.modelsLabel}</dt>
            <dd>
              {#if settings.models.length === 0}
                {copy.none}
              {:else}
                <ul class="ib-agent-chips" aria-label={copy.modelsLabel}>
                  {#each keyedByOccurrence(settings.models, (entry) => entry) as { key, item: entry } (key)}
                    <li><Badge variant="neutral" size="sm" monospace>{entry}</Badge></li>
                  {/each}
                </ul>
              {/if}
            </dd>
          </div>
          {#if isFile}
            <div class="ib-agent-settings__row">
              <dt>{copy.stepLimitLabel}</dt>
              <dd>{settings.stepLimit ?? copy.stepLimitDefault(DEFAULT_STEP_LIMIT)}</dd>
            </div>
            <div class="ib-agent-settings__row">
              <dt>{copy.defaultEffortLabel}</dt>
              <dd data-testid="agent-default-effort">{settings.effort ?? copy.notSet}</dd>
            </div>
          {/if}
        </dl>
      </section>
    {:else}
      {#if viewing === null}
        {#if overrides !== undefined}
          <AgentPluginNote {plugin} title={pluginTitle} mode="editable" />
        {/if}
        <form
          class="ib-agent-settings__form"
          aria-label={copy.heading}
          data-testid="agent-settings-form"
          novalidate
          onsubmit={submit}
        >
          {#if overrides !== undefined}
            <!-- A code agent's instructions are changed here, and saved with the rest by the one Save changes. -->
            <section class="ib-agent-section" aria-label={copy.instructionsHeading}>
              <SectionHeading level={2} title={copy.instructionsHeading} />
              <Textarea
                id="agent-settings-instructions"
                aria-label={copy.instructionsLabel}
                description={copy.instructionsNote}
                rows={10}
                disabled={save.isPending}
                bind:value={instructions}
              />
            </section>
          {/if}
          <!-- The Model section (rows 38u, 38v). -->
          <section class="ib-agent-section" aria-label={copy.modelLabel}>
            <SectionHeading level={2} title={copy.modelLabel} />
            <p class="ib-agent-settings__model" data-testid="agent-settings-model">
              {model === '' ? copy.modelNone : modelLineOf(model)}
            </p>
            {#if abilityLine !== ''}
              <p class="ib-agent-note" data-testid="agent-settings-abilities">{abilityLine}</p>
            {/if}
            {#if unconnected !== undefined}
              <Callout
                variant="warning"
                semantic="note"
                title={copy.noProvider.title(unconnected)}
                data-testid="agent-settings-no-provider"
              >
                <p>{copy.noProvider.description(shownName)}</p>
                {#snippet action()}
                  <Button
                    href={router.href(SETTINGS_MODELS_PATH)}
                    variant="secondary"
                    size="sm"
                    onclick={openSettings}
                    label={copy.noProvider.action}
                  />
                {/snippet}
              </Callout>
            {/if}
            <Select
              id="agent-settings-model"
              label={copy.modelLabel}
              {...hiddenLabel}
              presentation="listbox"
              placeholder={copy.modelChoose}
              options={modelOptions}
              value={model}
              disabled={save.isPending}
              onValueChange={(next: string) => (model = next)}
            />

            <div class="ib-agent-settings__switch" data-testid="agent-settings-models">
              <span class="ib-agent-settings__label">{copy.modelsLabel}</span>
              {#if models.length > 0}
                <ul class="ib-agent-chips" aria-label={copy.modelsLabel}>
                  {#each keyedByOccurrence(models, (entry) => entry) as { key, item: entry } (key)}
                    <li>
                      <Chip
                        mode="removable"
                        size="sm"
                        label={modelName(entry)}
                        removeAriaLabel={copy.removeModel(modelName(entry))}
                        disabled={save.isPending}
                        onRemove={() => removeModel(entry)}
                      />
                    </li>
                  {/each}
                </ul>
              {/if}
              <Select
                id="agent-settings-add-model"
                label={copy.addModel}
                {...hiddenLabel}
                size="sm"
                options={addOptions}
                value=""
                disabled={save.isPending || addOptions.length === 1}
                onValueChangeRequest={addModel}
              />
              <p class="ib-agent-note">{copy.modelsNote}</p>
            </div>

            <!-- The same control the agent editor uses for the default effort: a select that shows its value. -->
            <Select
              id="agent-settings-effort"
              label={copy.effortLabel}
              options={effortOptions}
              value={effort}
              disabled={save.isPending}
              onchange={(event) => chooseEffort(event.currentTarget.value)}
            />

            <Input
              id={STEP_LIMIT_ID}
              label={copy.stepLimitLabel}
              description={copy.stepLimitNote}
              placeholder={copy.stepLimitPlaceholder(DEFAULT_STEP_LIMIT)}
              inputmode="numeric"
              error={stepError}
              disabled={save.isPending}
              bind:value={stepLimit}
            />
          </section>

          <!-- One Save changes and Discard, with the version a save makes (row 38w). -->
          <div class="ib-agent-settings__actions">
            <Button
              data-changes
              type="submit"
              variant="primary"
              size="sm"
              loading={save.isPending}
              disabled={!dirty}
              label={copy.save}
            />
            <Button
              type="button"
              variant="secondary"
              size="sm"
              disabled={!dirty || save.isPending}
              onclick={discard}
              label={copy.discard}
            />
            <p class="ib-agent-note" data-testid="agent-settings-save-note">
              {copy.saveNote(nextVersion)}
            </p>
          </div>
        </form>
      {/if}

      <AgentVersions
        {id}
        currentHash={hash}
        current={detail.definition}
        ownTools={overrides?.ownTools}
        bind:viewing
      />

      {#if viewing === null && overrides === undefined}
        <!-- Demoted: the dialog holds the solid danger button (row 39a). -->
        <section class="ib-agent-section" aria-label={copy.deleteHeading}>
          <!-- The action at the inline end, as the Disable block's is. -->
          <SectionHeading level={2} title={copy.deleteHeading} description={copy.deleteNote}>
            {#snippet actions()}
              <Button
                data-changes
                variant="ghost-danger"
                size="sm"
                disabled={hash === null || removal.isPending}
                onclick={() => {
                  deleteError = undefined;
                  confirmingDelete = true;
                }}
                label={copy.deleteAction}
              />
            {/snippet}
          </SectionHeading>
        </section>
      {/if}
    {/if}

    {#if disableable && viewing === null}
      <!-- Last on the tab: an agent defined in code is disabled, never deleted, and Enable agent
           takes Disable's place once it is (rows 38y, 40d). -->
      <section
        class="ib-agent-section"
        aria-label={disabled ? copy.disable.enabledHeading : copy.disable.heading}
        data-testid="agent-disable"
      >
        <!-- The action sits at the inline end, through the heading's actions (design review 1). -->
        {#if disabled}
          <SectionHeading
            level={2}
            title={copy.disable.enabledHeading}
            description={copy.disable.enabledNote(shownName)}
          >
            {#snippet actions()}
              <Button
                data-changes
                variant="secondary"
                size="sm"
                loading={toggle.isPending}
                onclick={() => toggle.mutate('enable')}
                label={copy.disable.enable}
              />
            {/snippet}
          </SectionHeading>
        {:else}
          <SectionHeading
            level={2}
            title={copy.disable.heading}
            description={copy.disable.note(
              shownName,
              plugin === null ? null : pluginTitle || plugin,
            )}
          >
            {#snippet actions()}
              <Button
                data-changes
                variant="ghost-danger"
                size="sm"
                disabled={toggle.isPending}
                onclick={() => (confirmingDisable = true)}
                label={copy.disable.action}
              />
            {/snippet}
          </SectionHeading>
        {/if}
      </section>
    {/if}
  {/if}
</div>

<!-- Reversible, so it asks without a typed confirmation (row 40d). -->
<ConfirmDialog
  bind:open={confirmingDisable}
  title={copy.disable.dialog.title(shownName)}
  description={copy.disable.dialog.description(chats, dependentsLine(disableReferences.data))}
  confirmLabel={copy.disable.dialog.confirm}
  destructive
  onConfirm={() => toggle.mutate('disable')}
/>

<AgentDeleteDialog
  bind:open={confirmingDelete}
  {id}
  {name}
  busy={removal.isPending}
  error={deleteError}
  onConfirm={confirmDelete}
/>

<!-- Asked before the tab is left with changes that are not saved (row 39b). -->
<ConfirmDialog
  bind:open={guard.asking}
  title={copy.leave.title}
  description={copy.leave.description(changed)}
  confirmLabel={copy.leave.confirm}
  cancelLabel={copy.leave.stay}
  destructive
  onCancel={() => guard.stay()}
  onConfirm={() => guard.leave({ keep: isOwnTab(guard.destination) })}
/>

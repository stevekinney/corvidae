<script lang="ts">
  /**
   * The Decisions part of Settings › Models (board SettingsShell, "Models, /settings/models"): the
   * model that answers yes-or-no and classification questions, its fallback, and the most decision
   * calls one task may make, as three setting rows that save as the person leaves them like the
   * rest of Settings (`../setting-field.svelte`).
   *
   * Both model rows choose among the rows the Bureau reports (`bureau.decisions.models`): every
   * catalog row that can decide, grouped by provider, a row that needs setup marked as such and still
   * selectable. The page only draws that list: which rows can decide, which are available and which
   * one answers while the chosen row cannot are the Bureau's rules, read from its fields. The
   * decision model row says which row answers only when the chosen row is not the one (nothing chosen,
   * a row the Bureau no longer lists, or one that needs setup), with a quiet link to Connect TypeSafe
   * while its plugin waits for a key, and warns, as an advisory and not an error, when the Bureau set
   * a stored value aside or the stored row is not in the list.
   */
  import { FormSection, Link, type SelectOption } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import { SETTINGS_COPY } from '../../../app/copy/settings.ts';
  import type { SchemaNode, SettingKeyState } from '../../../lib/bureau-settings.ts';
  import {
    decisionRowName,
    listDecisionModels,
    type DecisionModelRow,
  } from '../../../lib/bureau-decisions.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import SettingField from '../setting-field.svelte';
  import type { SettingsAutosave } from '../settings-autosave.svelte.ts';
  import type { Control } from '../settings-controls.ts';
  import type { SettingsForm } from '../settings-form.svelte.ts';
  import type { SettingsRevert } from '../settings-revert.svelte.ts';
  import { modelDisplayName } from './format-model.ts';

  interface Props {
    /** The schema node of each decision setting the Bureau publishes, by key. */
    nodes: Readonly<Record<string, SchemaNode>>;
    controls: ReadonlyMap<string, Control>;
    form: SettingsForm;
    autosave: SettingsAutosave;
    revert: SettingsRevert;
    stateOf: (key: string) => SettingKeyState;
    /** Each setting's value as it applies, which the limit shows while it has no value of its own. */
    effective: Readonly<Record<string, unknown>>;
    /** Whether the TypeSafe plugin is waiting for its key. */
    typesafeNeedsKey: boolean;
    /** The name a person knows a provider by, for the heading of its group of rows. */
    providerTitle: (provider: string) => string;
  }

  let {
    nodes,
    controls,
    form,
    autosave,
    revert,
    stateOf,
    effective,
    typesafeNeedsKey,
    providerTitle,
  }: Props = $props();

  const copy = MODELS_COPY.decisions;
  const TYPESAFE_PATH = '/settings/plugins?plugin=typesafe';

  const rows = createQuery(
    () => ({
      queryKey: queryKeys.decisionModels(),
      queryFn: ({ signal }) => listDecisionModels({ signal }),
      retry: false,
    }),
    undefined,
  );
  const listed = $derived<readonly DecisionModelRow[] | undefined>(rows.data);
  /** The row the Bureau says answers while the chosen row cannot. */
  const answering = $derived(listed?.find((row) => row.answering));

  /** The decision model the page holds: what the person chose, else nothing. */
  const chosenName = $derived.by(() => {
    const draft = form.draft('decisions.model');
    return typeof draft === 'string' && draft !== '' ? draft : undefined;
  });
  const chosen = $derived(
    chosenName === undefined
      ? undefined
      : listed?.find((row) => decisionRowName(row) === chosenName),
  );
  /** The fallback answers: no row is chosen, the one chosen is not listed, or it needs setup. */
  const fallbackAnswers = $derived(listed !== undefined && chosen?.availability !== 'available');

  /** What the decision model row says: which row answers while the chosen one cannot, or what it is. */
  const modelDescription = $derived.by(() => {
    if (!fallbackAnswers) return copy.model.description;
    return answering === undefined
      ? copy.model.nothingAnswers
      : copy.model.fallbackAnswers(modelDisplayName(answering.model));
  });
  /** An advisory in the page's words (never the Bureau's, which is written for a settings file). */
  const modelWarning = $derived.by(() => {
    if (stateOf('decisions.model').problem !== undefined) return copy.model.dropped;
    return listed !== undefined && chosenName !== undefined && chosen === undefined
      ? copy.model.missing(chosenName)
      : undefined;
  });

  /** One option per row, grouped by its provider; a row that needs setup is marked and still chosen. */
  function optionsFor(current: unknown): SelectOption[] {
    const options = (listed ?? []).map((row): SelectOption => {
      const provider = providerTitle(row.provider);
      return {
        value: decisionRowName(row),
        label: modelDisplayName(row.model),
        group: provider,
        triggerSuffix: provider,
        ...(row.availability === 'needs-setup' ? { note: copy.needsSetup } : {}),
      };
    });
    // A stored row the list does not hold keeps its own name, unmarked, beside the warning.
    return typeof current === 'string' &&
      current !== '' &&
      !options.some((option) => option.value === current)
      ? [{ value: current, label: current }, ...options]
      : options;
  }

  /** The empty option of the fallback: the row that answers while it is empty, as the Bureau says. */
  const fallbackEmpty = $derived(
    form.draft('decisions.fallbackModel') === undefined && answering !== undefined
      ? SETTINGS_COPY.defaultOption(modelDisplayName(answering.model))
      : SETTINGS_COPY.notSet,
  );

  function openTypesafe(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(TYPESAFE_PATH);
  }
</script>

{#snippet connectTypesafe()}
  <Link href={router.href(TYPESAFE_PATH)} underline="always" onclick={openTypesafe}
    >{copy.model.connect}</Link
  >
{/snippet}

{#snippet field(
  key: string,
  label: string,
  description: string,
  extra: {
    descriptionAction?: typeof connectTypesafe | undefined;
    rowChoices?: readonly SelectOption[];
    emptyLabel?: string;
    warning?: string | undefined;
  } = {},
)}
  {@const node = nodes[key]}
  {@const control = controls.get(key)}
  {#if node !== undefined && control !== undefined}
    <SettingField
      name={key}
      {node}
      {control}
      {form}
      keyState={stateOf(key)}
      inForce={effective[key]}
      {autosave}
      reverted={revert.isReverted(key)}
      descriptionOverride={description}
      labelOverride={label}
      descriptionAction={extra.descriptionAction}
      rowChoices={extra.rowChoices}
      emptyLabel={extra.emptyLabel}
      warning={extra.warning}
      onEdit={() => revert.forget(key)}
    />
  {/if}
{/snippet}

<div
  class="ib-decisions"
  data-section="decisions"
  data-waiting={fallbackAnswers ? 'true' : undefined}
>
  <FormSection grouped heading={copy.heading} description={copy.description}>
    {@render field('decisions.model', copy.model.label, modelDescription, {
      descriptionAction: fallbackAnswers && typesafeNeedsKey ? connectTypesafe : undefined,
      rowChoices: optionsFor(form.draft('decisions.model')),
      emptyLabel: copy.model.none,
      warning: modelWarning,
    })}
    {@render field(
      'decisions.fallbackModel',
      copy.fallbackModel.label,
      copy.fallbackModel.description,
      {
        rowChoices: optionsFor(form.draft('decisions.fallbackModel')),
        emptyLabel: fallbackEmpty,
      },
    )}
    {@render field(
      'decisions.maximumPerTask',
      copy.maximumPerTask.label,
      copy.maximumPerTask.description,
    )}
  </FormSection>
</div>

<style>
  .ib-decisions {
    min-inline-size: 0;
  }
</style>

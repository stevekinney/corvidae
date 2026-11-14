<script lang="ts">
  /**
   * The Decisions part of Settings › Models (board SettingsShell, "Models, /settings/models"): the
   * model that answers yes-or-no and classification questions, its fallback, and the most decision
   * calls one task may make, as three setting rows that save as the person leaves them like the
   * rest of Settings (`../setting-field.svelte`).
   *
   * Both model rows choose among the rows the Bureau reports (`bureau.decisions.models`): every
   * catalog row that can decide, grouped by provider, a row that needs setup marked as such and still
   * selectable; the fallback model row offers only the rows the Bureau marks `canBeFallback`, because
   * the fallback skips the others. The page only draws that list: which rows can decide, which can be
   * the fallback, which are available and which one answers while the chosen row cannot are the
   * Bureau's rules, read from its fields. Both selects keep an empty option. The decision model row
   * says which row answers only when the chosen row is not the one (nothing chosen, a row the Bureau
   * no longer lists, or one that needs setup), with a quiet link to Connect TypeSafe while its plugin
   * waits for a key (said inside the warning, with no link, while the row also warns), and warns, as
   * an advisory and not an error, when the Bureau set a stored value aside or the stored row is not
   * in the list. While the rows are pending or their read failed, both selects stay unable to
   * choose and each shows what is saved as its one option, named as a person says its model; a
   * failed read is the decision model row's load error, in its warning tone with its quiet Try again.
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
  /** The row the Bureau says a decision goes to now. */
  const answering = $derived(listed?.find((row) => row.answering));
  /** The row the Bureau says the language-model fallback uses. */
  const fallbackRow = $derived(listed?.find((row) => row.fallback));
  /** The read of the rows failed: the description says so, and the selects wait for a read that works. */
  const failed = $derived(rows.isError);
  /** Both selects are unable to choose until the rows are here: while they load, and while their read failed. */
  const choosing = $derived(listed === undefined || failed);
  /** The rows the Bureau says the fallback can use, which the fallback model is chosen among. */
  const fallbackChoices = $derived(listed?.filter((row) => row.canBeFallback));

  /** The decision model the person chose and has not saved or has: the draft, which is `undefined` while none is set. */
  const storedName = $derived.by(() => {
    const draft = form.draft('decisions.model');
    return typeof draft === 'string' && draft !== '' ? draft : undefined;
  });
  /** The decision model in force: the one on the page, else the one the host applies by default. */
  const inForceName = $derived.by(() => {
    if (storedName !== undefined) return storedName;
    const applied = effective['decisions.model'];
    return typeof applied === 'string' && applied !== '' ? applied : undefined;
  });
  /**
   * Whether the row in force is the one that answers. The Bureau says which row answers (its
   * `answering` mark); the page only compares its name with the setting. Nothing here decides
   * whether a row is available, can decide or is allowed.
   */
  const inForceAnswers = $derived(
    answering !== undefined &&
      inForceName !== undefined &&
      decisionRowName(answering) === inForceName,
  );
  /** Another row answers, or none: the row in force is empty, missing, needs setup or is not allowed. */
  const fallbackAnswers = $derived(listed !== undefined && !inForceAnswers);

  /** What the decision model row says: what it is, or which row answers in its place. */
  const modelDescription = $derived.by(() => {
    if (!fallbackAnswers) return copy.model.description;
    return answering === undefined
      ? copy.model.nothingAnswers
      : copy.model.fallbackAnswers(modelDisplayName(answering.model));
  });
  /** The row offers Connect TypeSafe as a next step: another row answers while its plugin waits for a key. */
  const connectOffered = $derived(fallbackAnswers && typesafeNeedsKey);
  /**
   * An advisory in the page's words (never the Bureau's, which is written for a settings file).
   * While Connect TypeSafe is offered, the warning ends with it, so the row names its two next steps
   * once.
   */
  const modelWarning = $derived.by(() => {
    if (stateOf('decisions.model').problem !== undefined) {
      return connectOffered ? copy.model.droppedWaiting : copy.model.dropped;
    }
    if (
      listed !== undefined &&
      storedName !== undefined &&
      !listed.some((row) => decisionRowName(row) === storedName)
    ) {
      return connectOffered
        ? copy.model.missingWaiting(storedName)
        : copy.model.missing(storedName);
    }
    return undefined;
  });
  /** An advisory on the fallback row: the stored row is listed, and the Bureau's fallback never uses it. */
  const fallbackWarning = $derived.by(() => {
    const stored = form.draft('decisions.fallbackModel');
    if (typeof stored !== 'string' || stored === '') return undefined;
    const unusable = listed?.some((row) => !row.canBeFallback && decisionRowName(row) === stored);
    return unusable === true ? copy.fallbackModel.unusable(stored) : undefined;
  });

  /**
   * One option per row, grouped by its provider; a row that needs setup is marked and still chosen.
   * While the rows are not here (pending, or their read failed) the one option is the stored value,
   * named as a person says its model, with no provider and no "(default)", so the disabled trigger
   * says what is saved; a key that holds nothing has none, and keeps its empty label.
   */
  function optionsFor(
    offered: readonly DecisionModelRow[] | undefined,
    current: unknown,
  ): SelectOption[] {
    if (offered === undefined) {
      if (typeof current !== 'string' || current === '') return [];
      const slash = current.indexOf('/');
      return [{ value: current, label: modelDisplayName(current.slice(slash + 1)) }];
    }
    const options = offered.map((row): SelectOption => {
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

  /** The empty option of the fallback: the row the Bureau says the fallback uses while it is empty. */
  const fallbackEmpty = $derived(
    fallbackRow === undefined
      ? SETTINGS_COPY.notSet
      : SETTINGS_COPY.defaultOption(modelDisplayName(fallbackRow.model)),
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
    loadFailure?: { message: string; retry: () => void; retryLabel: string } | undefined;
    rowChoices?: readonly SelectOption[];
    emptyLabel?: string;
    warning?: string | undefined;
    disabled?: boolean;
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
      loadFailure={extra.loadFailure}
      rowChoices={extra.rowChoices}
      emptyLabel={extra.emptyLabel}
      warning={extra.warning}
      disabled={extra.disabled ?? false}
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
      descriptionAction:
        connectOffered && modelWarning === undefined && !failed ? connectTypesafe : undefined,
      loadFailure: failed
        ? {
            message: copy.model.loadFailed,
            retry: () => void rows.refetch(),
            retryLabel: copy.model.tryAgain,
          }
        : undefined,
      rowChoices: optionsFor(listed, form.draft('decisions.model')),
      warning: modelWarning,
      disabled: choosing,
    })}
    {@render field(
      'decisions.fallbackModel',
      copy.fallbackModel.label,
      copy.fallbackModel.description,
      {
        rowChoices: optionsFor(fallbackChoices, form.draft('decisions.fallbackModel')),
        emptyLabel: fallbackEmpty,
        warning: fallbackWarning,
        disabled: choosing,
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

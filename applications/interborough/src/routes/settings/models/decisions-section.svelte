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
  const listed = $derived(rows.data?.rows);
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
  function selectedRow(
    name: unknown,
    setting: 'configured' | 'configuredFallback',
  ): DecisionModelRow | undefined {
    if (typeof name !== 'string' || name === '') return undefined;
    return (
      listed?.find((row) => row[setting] === name) ??
      listed?.find((row) => decisionRowName(row) === name)
    );
  }

  const configuredHost = $derived(rows.data?.hostModel);
  const hostAnswers = $derived(
    configuredHost !== undefined && configuredHost !== null && configuredHost.name === inForceName,
  );
  const inForceAnswers = $derived(
    hostAnswers ||
      (answering !== undefined && answering === selectedRow(inForceName, 'configured')),
  );
  const fallbackAnswers = $derived(listed !== undefined && !inForceAnswers);

  /** What the decision model row says, including when a host model handles part of the routing. */
  const modelDescription = $derived.by(() => {
    if (hostAnswers && configuredHost !== undefined && configuredHost !== null) {
      const hostName = modelDisplayName(configuredHost.name);
      return answering === undefined
        ? copy.model.hostAnswers(hostName)
        : copy.model.hostAndFallback(hostName, modelDisplayName(answering.model));
    }
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
      !(hostAnswers || selectedRow(storedName, 'configured') !== undefined)
    ) {
      return connectOffered
        ? copy.model.missingWaiting(storedName)
        : copy.model.missing(storedName);
    }
    return undefined;
  });
  /** The choice stays visible when the Bureau cannot use it, alongside the fallback it reports. */
  const fallbackWarning = $derived.by(() => {
    const stored = form.draft('decisions.fallbackModel');
    if (listed === undefined || typeof stored !== 'string' || stored === '') return undefined;
    const selected = selectedRow(stored, 'configuredFallback');
    const fallback =
      fallbackRow === undefined
        ? copy.fallbackModel.unavailable
        : copy.fallbackModel.inUse(modelDisplayName(fallbackRow.model));
    if (selected === undefined) return `${copy.fallbackModel.missing(stored)} ${fallback}`;

    const name = `${modelDisplayName(selected.model)}, ${providerTitle(selected.provider)}`;
    if (!selected.canBeFallback) return copy.fallbackModel.unusable(name);
    if (selected.availability === 'needs-setup' && !selected.fallback) {
      return `${copy.fallbackModel.needsSetup(name)} ${fallback}`;
    }
    return undefined;
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
    setting: 'configured' | 'configuredFallback',
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
    if (typeof current !== 'string' || current === '') return options;
    if (options.some((option) => option.value === current)) return options;
    if (setting === 'configured' && configuredHost?.name === current) {
      return [{ value: current, label: modelDisplayName(current) }, ...options];
    }
    // A stored row the Bureau lists but this select does not offer (the fallback's `unusable`) is
    // named as the other row names it. One the Bureau does not list keeps its own id, unmarked,
    // beside the warning.
    const known = selectedRow(current, setting);
    return [
      known === undefined
        ? { value: current, label: current }
        : {
            value: current,
            label: modelDisplayName(known.model),
            triggerSuffix: providerTitle(known.provider),
          },
      ...options,
    ];
  }

  /**
   * The empty option of the fallback: the row the Bureau says the fallback uses while it is empty.
   * While the rows are not here it is `undefined`, so the field names the key's own default (the
   * value in force) as it does for any other select, and reads the same as it does once loaded.
   */
  const fallbackEmpty = $derived(
    listed === undefined
      ? undefined
      : fallbackRow === undefined
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
    emptyLabel?: string | undefined;
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
      rowChoices: optionsFor(listed, form.draft('decisions.model'), 'configured'),
      warning: modelWarning,
      disabled: choosing,
    })}
    {@render field(
      'decisions.fallbackModel',
      copy.fallbackModel.label,
      copy.fallbackModel.description,
      {
        rowChoices: optionsFor(
          fallbackChoices,
          form.draft('decisions.fallbackModel'),
          'configuredFallback',
        ),
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

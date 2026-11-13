<script lang="ts">
  /**
   * The Decisions part of Settings › Models (board SettingsShell, "Models, /settings/models"): the
   * model that answers yes-or-no and classification questions, its fallback, and the most decision
   * calls one task may make, as three setting rows that save as the person leaves them like the
   * rest of Settings (`../setting-field.svelte`). TypeSafe is the decision model and its key is
   * connected under Plugins. While its plugin waits for a key the fallback model answers, so all
   * three rows stay editable and the decision model row says so, with a quiet link to Connect
   * TypeSafe after its description.
   */
  import { FormSection, Link } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { MODELS_COPY } from '../../../app/copy/models.ts';
  import {
    decisionRowNamed,
    getAgentCatalog,
    hasDecisionModel,
  } from '../../../lib/agent-definitions.ts';
  import type { SchemaNode, SettingKeyState } from '../../../lib/bureau-settings.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import SettingField from '../setting-field.svelte';
  import type { ModelPolicy } from '../model-policy-edit.ts';
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
    /** The model policy, which the Bureau applies before it chooses the model that answers. */
    policy: ModelPolicy;
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
    policy,
  }: Props = $props();

  const copy = MODELS_COPY.decisions;
  const TYPESAFE_PATH = '/settings/plugins?plugin=typesafe';

  /** Whether the decision model is TypeSafe's, or unset (which the host defaults to TypeSafe when it loads). */
  const usesTypesafe = $derived.by(() => {
    const model = form.draft('decisions.model');
    return model === undefined || (typeof model === 'string' && model.startsWith('typesafe/'));
  });
  /** TypeSafe is the decision model but has no key, so the fallback model answers. */
  const waiting = $derived(typesafeNeedsKey && usesTypesafe);

  // The fallback is the model answering while TypeSafe waits, so the catalog says which one it is.
  const catalog = createQuery(
    () => ({
      queryKey: queryKeys.agents.catalog(),
      queryFn: ({ signal }) => getAgentCatalog({ signal }),
      retry: false,
    }),
    undefined,
  );
  /** The fallback model in force: the one on the page, else the one the host applies by default. */
  const fallbackInForce = $derived.by(() => {
    const draft = form.draft('decisions.fallbackModel');
    const applied = effective['decisions.fallbackModel'];
    if (typeof draft === 'string' && draft !== '') return draft;
    return typeof applied === 'string' ? applied : undefined;
  });
  /** What the decision model row says while TypeSafe waits, naming the model that answers. */
  const waitingWords = $derived.by(() => {
    const models = catalog.data?.models;
    if (models === undefined) return copy.model.waitingUnnamed;
    if (!hasDecisionModel({ models }, policy)) return copy.model.waitingNothing;
    const row =
      fallbackInForce === undefined ? undefined : decisionRowNamed(models, fallbackInForce, policy);
    return row === undefined
      ? copy.model.waitingUnnamed
      : copy.model.waiting(modelDisplayName(row.model));
  });

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
  descriptionAction?: typeof connectTypesafe,
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
      {descriptionAction}
      {policy}
      onEdit={() => revert.forget(key)}
    />
  {/if}
{/snippet}

<div class="ib-decisions" data-section="decisions" data-waiting={waiting ? 'true' : undefined}>
  <FormSection grouped heading={copy.heading} description={copy.description}>
    {@render field(
      'decisions.model',
      copy.model.label,
      waiting ? waitingWords : copy.model.description,
      waiting ? connectTypesafe : undefined,
    )}
    {@render field(
      'decisions.fallbackModel',
      copy.fallbackModel.label,
      copy.fallbackModel.description,
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

<script lang="ts">
  /**
   * The Decisions part of Settings › Models (board SettingsShell, "Models · /settings/models"): the
   * model that answers yes-or-no and classification questions, its fallback, and the most decision
   * calls one task may make, as three setting rows that save as the person leaves them like the
   * rest of Settings (`../setting-field.svelte`). TypeSafe is the decision model and lives here, not
   * under Providers. While its plugin waits for a key, the decision model row offers Connect
   * TypeSafe, and the two rows that depend on it are disabled and say to connect it first.
   */
  import { Button, FormSection, NumberInput, Select, SettingRow } from '@lostgradient/cinder';

  import { MODELS_COPY } from '../../../app/copy.ts';
  import type { SchemaNode, SettingKeyState } from '../../../lib/bureau-settings.ts';
  import { router } from '../../../lib/router.svelte.ts';
  import SettingField from '../setting-field.svelte';
  import type { SettingsAutosave } from '../settings-autosave.svelte.ts';
  import type { Control } from '../settings-controls.ts';
  import type { SettingsForm } from '../settings-form.svelte.ts';
  import type { SettingsRevert } from '../settings-revert.svelte.ts';

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
  }

  let { nodes, controls, form, autosave, revert, stateOf, effective, typesafeNeedsKey }: Props =
    $props();

  const copy = MODELS_COPY.decisions;
  const TYPESAFE_PATH = '/settings/plugins?plugin=typesafe';

  /** Whether the decision model is TypeSafe's, or unset (which the host defaults to TypeSafe when it loads). */
  const usesTypesafe = $derived.by(() => {
    const model = form.draft('decisions.model');
    return model === undefined || (typeof model === 'string' && model.startsWith('typesafe:'));
  });
  /** The rows wait for TypeSafe: its plugin has no key and the decision model is its. */
  const waiting = $derived(typesafeNeedsKey && usesTypesafe);

  function openTypesafe(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    router.navigate(TYPESAFE_PATH);
  }

  const maximumPerTask = $derived.by(() => {
    const own = form.draft('decisions.maximumPerTask');
    const applied = effective['decisions.maximumPerTask'];
    return typeof own === 'number' ? own : typeof applied === 'number' ? applied : null;
  });
</script>

{#snippet field(key: string, label: string, description: string)}
  {@const node = nodes[key]}
  {@const control = controls.get(key)}
  {#if node !== undefined && control !== undefined}
    <SettingField
      name={key}
      {node}
      {control}
      {form}
      keyState={stateOf(key)}
      {autosave}
      reverted={revert.isReverted(key)}
      descriptionOverride={description}
      labelOverride={label}
      onEdit={() => revert.forget(key)}
    />
  {/if}
{/snippet}

<div class="ib-decisions" data-section="decisions">
  <FormSection grouped heading={copy.heading} description={copy.description}>
    {#if waiting}
      <div class="ib-decisions__row" data-setting="decisions.model" data-waiting="true">
        <SettingRow
          id="weft-setting-decisions-model"
          label={copy.model.label}
          identifier="decisions.model"
          description={copy.model.description}
        >
          {#snippet control()}
            <Button
              variant="secondary"
              size="sm"
              href={router.href(TYPESAFE_PATH)}
              onclick={openTypesafe}>{copy.model.connect}</Button
            >
          {/snippet}
        </SettingRow>
      </div>
      <div class="ib-decisions__row" data-setting="decisions.fallbackModel" data-waiting="true">
        <SettingRow
          id="weft-setting-decisions-fallbackModel"
          label={copy.fallbackModel.label}
          identifier="decisions.fallbackModel"
          description={copy.fallbackModel.description}
          disabled
        >
          {#snippet control()}
            <Select
              id="weft-setting-decisions-fallbackModel"
              label={copy.fallbackModel.label}
              labelVisible={false}
              options={[{ value: '', label: copy.fallbackModel.connectFirst }]}
              value=""
              disabled
            />
          {/snippet}
        </SettingRow>
      </div>
      <div class="ib-decisions__row" data-setting="decisions.maximumPerTask" data-waiting="true">
        <SettingRow
          id="weft-setting-decisions-maximumPerTask"
          label={copy.maximumPerTask.label}
          identifier="decisions.maximumPerTask"
          description={copy.maximumPerTask.connectFirst}
          disabled
        >
          {#snippet control()}
            <NumberInput
              id="weft-setting-decisions-maximumPerTask"
              value={maximumPerTask}
              disabled
            />
          {/snippet}
        </SettingRow>
      </div>
    {:else}
      {@render field('decisions.model', copy.model.label, copy.model.description)}
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
    {/if}
  </FormSection>
</div>

<style>
  .ib-decisions {
    min-inline-size: 0;
  }

  .ib-decisions__row {
    min-inline-size: 0;
  }
</style>

<script lang="ts">
  /**
   * Settings › Model policy: the `modelPolicy` setting in plain words, as two sections. Allowed
   * models is what no run may use, whoever starts it; Your preferences is what the one local
   * caller's own runs choose from. Each field is a list or a choice, never JSON. An edit goes into
   * the settings form's draft like any other setting, and is saved with it. The revision the policy
   * carries is raised by the edit, never typed (`model-policy-edit.ts`).
   */
  import { FormField, Select, TagInput } from '@lostgradient/cinder';
  import { tick } from 'svelte';

  import { MODEL_POLICY_COPY as copy } from '../../app/copy.ts';
  import type { SettingKeyState } from '../../lib/bureau-settings.ts';
  import {
    committedPolicy,
    fieldOf,
    policyOf,
    withField,
    type PolicyTarget,
  } from './model-policy-edit.ts';
  import { MODEL_POLICY_KEY } from './settings-controls.ts';
  import type { SettingsForm } from './settings-form.svelte.ts';

  interface Props {
    form: SettingsForm;
    keyState: SettingKeyState;
  }

  let { form, keyState }: Props = $props();

  /** A provider's name, as the policy takes it. */
  const PROVIDER = /^[a-z](?:[a-z0-9-]*[a-z0-9])?$/;

  const stored = $derived(policyOf(form.baseline(MODEL_POLICY_KEY)));
  const current = $derived(policyOf(form.draft(MODEL_POLICY_KEY)));

  function edit(target: PolicyTarget, field: string, value: unknown): void {
    const committed = committedPolicy(stored, withField(current, target, field, value));
    // Back to the stored policy is no change at all, even when the setting had no value.
    form.set(
      MODEL_POLICY_KEY,
      committed === stored && form.baseline(MODEL_POLICY_KEY) === undefined ? undefined : committed,
    );
  }

  type ListField = { target: PolicyTarget; field: string; label: string; provider: boolean };
  type ChoiceField = {
    target: PolicyTarget;
    field: string;
    label: string;
    options: Readonly<Record<string, string>>;
    empty: string;
  };

  const allowedLists: readonly ListField[] = [
    {
      target: 'allowed-models',
      field: 'deniedProviders',
      label: copy.fields.deniedProviders,
      provider: true,
    },
    {
      target: 'allowed-models',
      field: 'deniedModels',
      label: copy.fields.deniedModels,
      provider: false,
    },
    {
      target: 'allowed-models',
      field: 'deniedRoutes',
      label: copy.fields.deniedRoutes,
      provider: false,
    },
    {
      target: 'allowed-models',
      field: 'deniedRegions',
      label: copy.fields.deniedRegions,
      provider: false,
    },
  ];
  const allowedChoices: readonly ChoiceField[] = [
    {
      target: 'allowed-models',
      field: 'requireDataPolicy',
      label: copy.fields.requireDataPolicy,
      options: copy.options.dataPolicy,
      empty: copy.notRequired,
    },
  ];
  const preferenceLists: readonly ListField[] = [
    {
      target: 'your-preferences',
      field: 'allowedProviders',
      label: copy.fields.allowedProviders,
      provider: true,
    },
    {
      target: 'your-preferences',
      field: 'deniedProviders',
      label: copy.fields.preferredDeniedProviders,
      provider: true,
    },
    {
      target: 'your-preferences',
      field: 'allowedModels',
      label: copy.fields.allowedModels,
      provider: false,
    },
    {
      target: 'your-preferences',
      field: 'deniedModels',
      label: copy.fields.preferredDeniedModels,
      provider: false,
    },
  ];
  const preferenceChoices: readonly ChoiceField[] = [
    {
      target: 'your-preferences',
      field: 'dataPolicy',
      label: copy.fields.dataPolicy,
      options: copy.options.dataPolicy,
      empty: copy.noPreference,
    },
    {
      target: 'your-preferences',
      field: 'defaultEffort',
      label: copy.fields.defaultEffort,
      options: copy.options.effort,
      empty: copy.noPreference,
    },
    {
      target: 'your-preferences',
      field: 'costPreference',
      label: copy.fields.costPreference,
      options: copy.options.cost,
      empty: copy.noPreference,
    },
    {
      target: 'your-preferences',
      field: 'latencyPreference',
      label: copy.fields.latencyPreference,
      options: copy.options.latency,
      empty: copy.noPreference,
    },
    {
      target: 'your-preferences',
      field: 'effortFallbackMode',
      label: copy.fields.effortFallbackMode,
      options: copy.options.effortFallback,
      empty: copy.noPreference,
    },
  ];

  function listOf(target: PolicyTarget, field: string): string[] {
    const value = fieldOf(current, target, field);
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string') : [];
  }

  function choiceOf(target: PolicyTarget, field: string): string {
    const value = fieldOf(current, target, field);
    return typeof value === 'string' ? value : '';
  }

  const idOf = (target: PolicyTarget, field: string): string =>
    `weft-model-policy-${target}-${field}`;

  let root = $state<HTMLElement | null>(null);

  /**
   * Tells the form which lists hold text that was typed but not added. A `TagInput` outside a
   * `<form>` adds its text only on Enter or a comma, so leaving it there and saving would save the
   * policy without it; the form holds Save back and the page says why.
   */
  async function syncPending(): Promise<void> {
    // The list empties its own text after it adds it, which the DOM shows a tick later.
    await tick();
    if (root === null) return;
    for (const list of root.querySelectorAll<HTMLElement>('[data-tag-list]')) {
      const input = list.querySelector<HTMLInputElement>('input:not([type="hidden"])');
      form.setPendingEntry(list.dataset['tagList'] ?? '', (input?.value.trim() ?? '') !== '');
    }
  }
</script>

{#snippet lists(fields: readonly ListField[])}
  {#each fields as item (item.field)}
    <FormField
      id={idOf(item.target, item.field)}
      label={item.label}
      disabled={keyState.locked}
      {...item.provider ? { description: copy.providerName } : {}}
    >
      <div data-tag-list={idOf(item.target, item.field)}>
        <TagInput
          value={listOf(item.target, item.field)}
          disabled={keyState.locked}
          validate={item.provider ? (tag) => PROVIDER.test(tag) || copy.providerName : () => true}
          oninput={() => void syncPending()}
          onblur={() => void syncPending()}
          onValueChange={(tags) => {
            edit(item.target, item.field, tags);
            void syncPending();
          }}
        />
      </div>
    </FormField>
  {/each}
{/snippet}

{#snippet choices(fields: readonly ChoiceField[])}
  {#each fields as item (item.field)}
    <Select
      id={idOf(item.target, item.field)}
      label={item.label}
      disabled={keyState.locked}
      value={choiceOf(item.target, item.field)}
      options={[
        { value: '', label: item.empty },
        ...Object.entries(item.options).map(([value, label]) => ({ value, label })),
      ]}
      onchange={(event) => edit(item.target, item.field, event.currentTarget.value || undefined)}
    />
  {/each}
{/snippet}

<div
  bind:this={root}
  class="weft-model-policy"
  data-setting={MODEL_POLICY_KEY}
  data-locked={keyState.locked ? 'true' : 'false'}
  data-dirty={form.isDirty(MODEL_POLICY_KEY) ? 'true' : 'false'}
>
  {#if keyState.locked}
    <p class="weft-model-policy__note">{copy.lockedNote}</p>
  {/if}
  <!-- A list holds a word typed but not yet added, so starting over makes the lists again. -->
  {#key form.generation}
    <section class="weft-model-policy__section" aria-labelledby="weft-model-policy-allowed">
      <h2 id="weft-model-policy-allowed" class="weft-model-policy__title">
        {copy.allowedModels.title}
      </h2>
      <p class="weft-model-policy__description">{copy.allowedModels.description}</p>
      {@render lists(allowedLists)}
      {@render choices(allowedChoices)}
    </section>
    <section class="weft-model-policy__section" aria-labelledby="weft-model-policy-yours">
      <h2 id="weft-model-policy-yours" class="weft-model-policy__title">
        {copy.yourPreferences.title}
      </h2>
      <p class="weft-model-policy__description">{copy.yourPreferences.description}</p>
      {@render lists(preferenceLists)}
      {@render choices(preferenceChoices)}
    </section>
  {/key}
  {#if form.hasPendingEntry}
    <p class="weft-model-policy__note" role="alert">{copy.pendingEntry}</p>
  {/if}
  {#if form.error(MODEL_POLICY_KEY) !== undefined}
    <p class="weft-model-policy__note" role="alert">{form.error(MODEL_POLICY_KEY)}</p>
  {/if}
</div>

<style>
  .weft-model-policy {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-6);
    min-width: 0;
  }

  .weft-model-policy__section {
    display: flex;
    flex-direction: column;
    gap: var(--cinder-space-3);
    min-width: 0;
  }

  .weft-model-policy__title {
    margin: 0;
    padding-bottom: var(--cinder-space-2);
    border-bottom: 1px solid var(--cinder-border-muted);
    font-size: var(--cinder-text-lg);
    font-weight: 600;
  }

  .weft-model-policy__description,
  .weft-model-policy__note {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
  }
</style>

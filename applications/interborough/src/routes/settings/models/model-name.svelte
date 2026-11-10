<script lang="ts">
  /**
   * A model's name as a person says it ("Claude Opus 5.5") with the identifier the provider calls it
   * (`claude-opus-5-5`) small and monospaced: under the name in a table row (board SettingsShell,
   * "Models · provider connected"), or beside it in a row of checkboxes (board PageSettingsSections,
   * "Allowed models · provider connected"; board ListPatterns, "Option A, for operator tables only").
   * The name is a `<label>` when it names a control. Cinder has no component for this yet; it is
   * the one place both pages draw it, so a Cinder version replaces this file.
   */
  interface Props {
    /** The name a person says. */
    name: string;
    /** The identifier the provider calls the model. */
    identifier: string;
    /** Where the identifier sits: under the name or beside it. */
    layout?: 'stacked' | 'inline';
    /** The id of the control the name labels, which makes the name a `<label>`. */
    labelFor?: string;
  }

  let { name, identifier, layout = 'stacked', labelFor }: Props = $props();
</script>

<span class="ib-model-name" data-layout={layout}>
  {#if labelFor === undefined}
    <span class="ib-model-name__title">{name}</span>
  {:else}
    <label class="ib-model-name__title ib-model-name__title--label" for={labelFor}>{name}</label>
  {/if}
  <code class="ib-model-name__identifier" title={identifier}>{identifier}</code>
</span>

<style>
  .ib-model-name {
    display: inline-flex;
    min-inline-size: 0;
    max-inline-size: 100%;
    gap: var(--cinder-space-0-5) var(--cinder-space-2);
  }

  .ib-model-name[data-layout='stacked'] {
    flex-direction: column;
  }

  /* An identifier is one word, so it is never broken in pieces: a long one ends with an ellipsis,
   * and its title holds the whole of it (row 16c). */
  .ib-model-name__identifier {
    min-inline-size: 0;
    max-inline-size: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .ib-model-name[data-layout='inline'] {
    flex-wrap: wrap;
    align-items: baseline;
  }

  .ib-model-name__title {
    font-weight: var(--cinder-font-semibold);
  }

  .ib-model-name__title--label {
    cursor: pointer;
  }

  .ib-model-name__identifier {
    color: var(--cinder-text-muted);
    font-family: var(--cinder-font-mono);
    font-size: var(--cinder-text-xs);
  }
</style>

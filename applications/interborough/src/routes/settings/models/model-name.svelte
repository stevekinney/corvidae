<script lang="ts">
  import { Text } from '@lostgradient/cinder';

  /**
   * A model's name as a person says it ("Claude Opus 5.5") with the identifier the provider calls it
   * (`claude-opus-5-5`) small and monospaced: under the name in a table row (board SettingsShell,
   * "Models, provider connected"), or beside it in a row of checkboxes (board PageSettingsSections,
   * "Allowed models, provider connected"; board ListPatterns, "Option A, for operator tables only").
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

<!-- Each line ends with an ellipsis when it is too long, with the whole of it in the title (row 16c). -->
<span class="ib-model-name" data-layout={layout}>
  {#if labelFor === undefined}
    <span class="ib-model-name__title"><Text as="span" truncate="end" text={name} /></span>
  {:else}
    <label class="ib-model-name__title ib-model-name__title--label" for={labelFor}
      ><Text as="span" truncate="end" text={name} /></label
    >
  {/if}
  <code class="ib-model-name__identifier"><Text as="span" truncate="end" text={identifier} /></code>
</span>

<style>
  .ib-model-name {
    display: inline-flex;
    /* In a row of checkboxes the name takes the room its row has, so a long one stays beside its box. */
    flex: 1 1 0;
    min-inline-size: 0;
    max-inline-size: 100%;
    gap: var(--cinder-space-0-5) var(--cinder-space-2);
  }

  .ib-model-name[data-layout='stacked'] {
    flex-direction: column;
  }

  /* An identifier is one word, so it is never broken in pieces. */
  .ib-model-name__identifier {
    min-inline-size: 0;
    max-inline-size: 100%;
  }

  .ib-model-name[data-layout='inline'] {
    flex-wrap: wrap;
    align-items: baseline;
  }

  .ib-model-name__title {
    min-inline-size: 0;
    max-inline-size: 100%;
    font-weight: var(--cinder-font-semibold);
    overflow-wrap: anywhere;
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

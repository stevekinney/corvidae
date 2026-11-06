<script lang="ts">
  /**
   * `/settings/models`: one page, three sections, no tabs (board SettingsShell, "Models ·
   * /settings/models"). The body is `models-body.svelte`; this is the Settings frame around it, with
   * the section navigation, the heading and the settings the Decisions section edits.
   */
  import { MODELS_COPY } from '../../../app/copy.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import ModelsBody from './models-body.svelte';
</script>

<SettingsFrame title={MODELS_COPY.title} intro={MODELS_COPY.intro} page="settings-models">
  {#snippet body({ schema, snapshot })}
    <ModelsBody {schema} {snapshot} />
  {/snippet}
</SettingsFrame>

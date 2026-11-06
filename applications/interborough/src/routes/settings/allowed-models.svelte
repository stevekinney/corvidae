<script lang="ts">
  /**
   * `/settings/allowed-models`: which models agents may use, and what to prefer among them
   * (`allowed-models-body.svelte`). It edits the `modelPolicy` setting through
   * `bureau.settings.update`, and saves explicitly because a save raises the policy revision.
   */
  import { ALLOWED_MODELS_COPY, SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import AllowedModelsBody from './allowed-models-body.svelte';
  import SettingsFrame from './settings-frame.svelte';
</script>

<SettingsFrame
  title={SETTINGS_SECTION_COPY.modelPolicy}
  intro={ALLOWED_MODELS_COPY.intro}
  page="settings-allowed-models"
>
  {#snippet body({ schema, snapshot })}
    <AllowedModelsBody {schema} {snapshot} />
  {/snippet}
</SettingsFrame>

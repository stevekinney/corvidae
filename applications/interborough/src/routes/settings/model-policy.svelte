<script lang="ts">
  /**
   * `/settings/model-policy`: which providers and models agents may use (`model-policy-editor.svelte`),
   * edited through the `modelPolicy` setting and saved with `bureau.settings.update`.
   */
  import { MODEL_POLICY_COPY, SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import SettingsFrame from './settings-frame.svelte';
</script>

<SettingsFrame
  section="model-policy"
  title={SETTINGS_SECTION_COPY.modelPolicy}
  intro={MODEL_POLICY_COPY.intro}
  page="settings-model-policy"
/>

<script lang="ts">
  /**
   * `/settings`, the General section: the Bureau's runtime settings other than the models, the
   * data and retention windows and A2A, drawn from `bureau.settings.schema()` and saved one at a
   * time as each is left through `bureau.settings.update` (`general-settings.svelte`), with the
   * preferences of this browser under them.
   */
  import { SETTINGS_COPY, SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import GeneralSettings from './general-settings.svelte';
  import SettingsFrame from './settings-frame.svelte';
</script>

<SettingsFrame
  section="general"
  title={SETTINGS_SECTION_COPY.general}
  intro={SETTINGS_COPY.general.intro}
  page="settings"
>
  {#snippet body({ schema, snapshot })}
    <GeneralSettings {schema} {snapshot} />
  {/snippet}
</SettingsFrame>

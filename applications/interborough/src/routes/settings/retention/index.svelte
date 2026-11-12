<script lang="ts">
  /**
   * `/settings/data-and-retention`: how long Interborough keeps what it records, and how much space
   * the records take (board PageSettingsSections, "Data and retention"). The body is
   * `retention-body.svelte`; this is the Settings frame around it, with the section navigation, the
   * heading and the settings the section edits.
   */
  import { DATA_RETENTION_COPY, SETTINGS_SECTION_COPY } from '../../../app/copy/settings.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import RetentionBody from './retention-body.svelte';
</script>

<SettingsFrame
  title={SETTINGS_SECTION_COPY.dataAndRetention}
  intro={DATA_RETENTION_COPY.intro}
  page="settings-data-and-retention"
>
  {#snippet body({ schema, snapshot, setHeaderStatus })}
    <RetentionBody {schema} {snapshot} {setHeaderStatus} />
  {/snippet}
</SettingsFrame>

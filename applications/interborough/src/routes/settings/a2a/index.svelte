<script lang="ts">
  /**
   * `/settings/a2a`: what an A2A caller can reach on this host (board PageSettingsSections, "A2A ·
   * /settings/a2a"). The body is `a2a-body.svelte`; this is the Settings frame around it, with the
   * section navigation, the heading and the settings the section edits.
   */
  import { A2A_COPY, SETTINGS_SECTION_COPY } from '../../../app/copy.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import A2aBody from './a2a-body.svelte';
</script>

<SettingsFrame title={SETTINGS_SECTION_COPY.a2a} intro={A2A_COPY.intro} page="settings-a2a">
  {#snippet body({ schema, snapshot })}
    <A2aBody {schema} {snapshot} />
  {/snippet}
</SettingsFrame>

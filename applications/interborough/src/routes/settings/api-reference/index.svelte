<script lang="ts">
  /**
   * `/settings/api-reference`: what other programs can do with Interborough, and what this session
   * may do (board PageSettingsSections, "API reference"). The body is `api-reference-body.svelte`;
   * this is the Settings frame around it, with the section navigation, the heading and the settings
   * the restart notice counts.
   */
  import { API_REFERENCE_COPY } from '../../../app/copy.ts';
  import SettingsFrame from '../settings-frame.svelte';
  import ApiReferenceBody from './api-reference-body.svelte';
</script>

<SettingsFrame
  section="api-reference"
  title={API_REFERENCE_COPY.title}
  intro={API_REFERENCE_COPY.intro}
  page="settings-api-reference"
>
  {#snippet body({ schema, snapshot })}
    <ApiReferenceBody {schema} {snapshot} />
  {/snippet}
</SettingsFrame>

<script lang="ts">
  /**
   * `/settings/api-reference`: what the engine exposes and what the caller may do with it: the
   * workflow types it has registered, its discovery documents and operations, and the caller's
   * scopes. These are the System page's tabs for that audience, moved here unchanged.
   */
  import { SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import SystemSections from '../system/system-sections.svelte';
  import { API_REFERENCE_TABS } from '../system/system-tabs.ts';
  import SettingsSectionNav from './settings-section-nav.svelte';
</script>

<section class="weft-settings-section" data-page="settings-api-reference">
  <SettingsSectionNav />
  <h1 class="weft-settings-section__title">{SETTINGS_SECTION_COPY.apiReference}</h1>
  <SystemSections
    tabs={API_REFERENCE_TABS}
    path="/settings/api-reference"
    label={SETTINGS_SECTION_COPY.apiReference}
  />
</section>

<style>
  .weft-settings-section__title {
    margin: 0 0 var(--cinder-space-3);
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }
</style>

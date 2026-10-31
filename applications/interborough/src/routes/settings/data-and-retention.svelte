<script lang="ts">
  /**
   * `/settings/data-and-retention`: how long the engine keeps finished workflows and how often it
   * sweeps them. The retention overview is the System page's, moved here unchanged.
   */
  import { SETTINGS_SECTION_COPY } from '../../app/copy.ts';
  import RetentionPanel from '../system/retention-panel.svelte';
  import SettingsSectionNav from './settings-section-nav.svelte';
</script>

<section class="weft-settings-section" data-page="settings-data-and-retention">
  <SettingsSectionNav />
  <h1 class="weft-settings-section__title">{SETTINGS_SECTION_COPY.dataAndRetention}</h1>
  <RetentionPanel />
</section>

<style>
  .weft-settings-section__title {
    margin: 0 0 var(--cinder-space-3);
    font-size: var(--cinder-text-xl);
    font-weight: 600;
  }
</style>

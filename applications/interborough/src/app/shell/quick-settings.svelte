<script lang="ts">
  /**
   * The top bar's quick settings (design row 03b): one small icon that opens a popover of
   * personal preferences for this browser, the theme, the density and the sidebar's icon rail,
   * with a link to every setting. The theme is the `ThemeStore`'s, and the density and the rail
   * are the shell's `LayoutPreferences`, so each is remembered across reloads.
   */
  import {
    Button,
    Link,
    Popover,
    Segment,
    SegmentedControl,
    ThemeSwitch,
    Toggle,
  } from '@lostgradient/cinder';
  import { Settings2 } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { QUICK_SETTINGS_COPY } from '../copy.ts';
  import type { DensityPreference, LayoutPreferences } from '../layout-preferences.svelte.ts';
  import type { ThemeStore } from '../theme.svelte.ts';

  interface QuickSettingsProps {
    theme: ThemeStore;
    layout: LayoutPreferences;
  }

  let { theme, layout }: QuickSettingsProps = $props();

  let open = $state(false);

  function openAllSettings(event: MouseEvent): void {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) {
      return;
    }
    event.preventDefault();
    open = false;
    router.navigate('/settings');
  }
</script>

<Popover bind:open placement="bottom-end" label={QUICK_SETTINGS_COPY.trigger}>
  {#snippet trigger()}
    <Button
      variant="ghost"
      iconOnly
      aria-label={QUICK_SETTINGS_COPY.trigger}
      title={QUICK_SETTINGS_COPY.trigger}
      onclick={() => (open = !open)}
    >
      <Settings2 aria-hidden="true" size={16} />
    </Button>
  {/snippet}
  <div class="weft-quick-settings">
    <div class="weft-quick-settings__row">
      <span class="weft-quick-settings__label">{QUICK_SETTINGS_COPY.theme}</span>
      <ThemeSwitch
        value={theme.mode}
        label={QUICK_SETTINGS_COPY.theme}
        onValueChange={(mode) => theme.set(mode)}
      />
    </div>
    <div class="weft-quick-settings__row">
      <span class="weft-quick-settings__label">{QUICK_SETTINGS_COPY.density}</span>
      <SegmentedControl
        id="weft-quick-settings-density"
        label={QUICK_SETTINGS_COPY.density}
        labelVisible={false}
        size="sm"
        value={layout.density}
        onValueChange={(density: DensityPreference) => layout.setDensity(density)}
      >
        <Segment value="comfortable">{QUICK_SETTINGS_COPY.comfortable}</Segment>
        <Segment value="compact">{QUICK_SETTINGS_COPY.compact}</Segment>
      </SegmentedControl>
    </div>
    <div class="weft-quick-settings__row">
      <span class="weft-quick-settings__label">{QUICK_SETTINGS_COPY.sidebar}</span>
      <Toggle
        id="weft-quick-settings-sidebar"
        label={QUICK_SETTINGS_COPY.collapsed}
        checked={layout.sidebarCollapsed}
        onValueChange={(collapsed) => layout.setSidebarCollapsed(collapsed)}
      />
    </div>
    <Link href={router.href('/settings')} onclick={openAllSettings}>
      {QUICK_SETTINGS_COPY.allSettings}
    </Link>
  </div>
</Popover>

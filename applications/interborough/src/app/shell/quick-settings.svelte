<script lang="ts">
  /**
   * The top bar's quick settings (design row 02y): the sliders icon (the gear is Settings) opens a
   * popover of personal preferences for this browser, titled "Quick settings": the theme (Cinder's
   * `ThemeSwitch`), whether the sidebar is expanded or collapsed to its rail, and a link to every
   * setting. There is no density switch: one density everywhere.
   *
   * The Sidebar choice is the person's preference and applies at 1024px and wider; below that the
   * rail or the drawer rules win (design row 04b, `../shell/shell-navigation.svelte.ts`). The
   * theme is the `ThemeStore`'s and the preference is the shell's `LayoutPreferences`, so each is
   * remembered across reloads.
   */
  import {
    Button,
    Link,
    Popover,
    Segment,
    SegmentedControl,
    ThemeSwitch,
  } from '@lostgradient/cinder';
  import { ChevronRight, Settings, SlidersHorizontal } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { QUICK_SETTINGS_COPY } from '../copy.ts';
  import type { LayoutPreferences } from '../layout-preferences.svelte.ts';
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

<Popover
  bind:open
  placement="bottom-end"
  label={QUICK_SETTINGS_COPY.trigger}
  class="weft-quick-settings-popover"
>
  {#snippet trigger()}
    <Button
      variant="ghost"
      iconOnly
      quiet
      class="weft-shell-topbar-control"
      aria-label={QUICK_SETTINGS_COPY.trigger}
      title={QUICK_SETTINGS_COPY.trigger}
      onclick={() => (open = !open)}
    >
      <SlidersHorizontal aria-hidden="true" size={16} />
    </Button>
  {/snippet}
  <div class="weft-quick-settings">
    <h2 class="weft-quick-settings__title">{QUICK_SETTINGS_COPY.trigger}</h2>
    <div class="weft-quick-settings__row">
      <span class="weft-quick-settings__label">{QUICK_SETTINGS_COPY.theme}</span>
      <ThemeSwitch
        value={theme.mode}
        label={QUICK_SETTINGS_COPY.themeLabel}
        onValueChange={(mode) => theme.set(mode)}
      />
    </div>
    <div class="weft-quick-settings__row">
      <span class="weft-quick-settings__label">{QUICK_SETTINGS_COPY.sidebar}</span>
      <SegmentedControl
        id="weft-quick-settings-sidebar"
        label={QUICK_SETTINGS_COPY.sidebar}
        labelVisible={false}
        size="sm"
        value={layout.sidebarCollapsed ? 'collapsed' : 'expanded'}
        onValueChange={(choice: 'expanded' | 'collapsed') =>
          layout.setSidebarCollapsed(choice === 'collapsed')}
      >
        <Segment value="expanded">{QUICK_SETTINGS_COPY.expanded}</Segment>
        <Segment value="collapsed">{QUICK_SETTINGS_COPY.collapsed}</Segment>
      </SegmentedControl>
    </div>
    <Link
      href={router.href('/settings')}
      color="inherit"
      underline="none"
      class="weft-quick-settings__all"
      onclick={openAllSettings}
    >
      <span class="weft-quick-settings__all-label">
        <Settings aria-hidden="true" size={15} />
        {QUICK_SETTINGS_COPY.allSettings}
      </span>
      <ChevronRight aria-hidden="true" size={16} />
    </Link>
  </div>
</Popover>

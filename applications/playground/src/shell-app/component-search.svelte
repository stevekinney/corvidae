<script lang="ts">
  /*
   * "Search components": the sidebar trigger and the Cmd/Ctrl+K shortcut for the
   * component palette.
   *
   * Rendered only inside the sidebar, which exists only on the interactive home
   * and documentation pages, so snapshot and preview surfaces never get a
   * palette or a shortcut. The palette module loads the first time the reader
   * focuses, hovers, or activates the trigger (or presses the shortcut), and the
   * loaded module is reused for every later open.
   */
  import { Button } from '@lostgradient/cinder';
  import Search from 'lucide-svelte/icons/search';
  import { tick, type Component } from 'svelte';

  import {
    COMPONENT_SEARCH_LABEL,
    COMPONENT_SEARCH_LISTENING_ATTRIBUTE,
    COMPONENT_SEARCH_TRIGGER_ATTRIBUTE,
    isComponentSearchShortcut,
  } from './component-search-shortcut.ts';

  type PaletteProps = {
    open: boolean;
    components: readonly string[];
    returnFocusTo: HTMLElement | null;
  };
  type PaletteModule = { default: Component<PaletteProps, Record<string, never>, 'open'> };

  type Props = {
    components: readonly string[];
    /**
     * Loads the palette module. Defaults to the lazy chunk; tests pass their own
     * to observe loading, failure, and retry without a bundler.
     */
    loadPaletteModule?: () => Promise<PaletteModule>;
  };

  let { components, loadPaletteModule = () => import('./component-search-palette.svelte') }: Props =
    $props();

  let container: HTMLDivElement | undefined = $state();
  let Palette = $state<PaletteModule['default'] | null>(null);
  let isOpen = $state(false);
  let returnFocusTo = $state<HTMLElement | null>(null);

  let paletteModule: Promise<PaletteModule> | null = null;
  let opening = false;

  function loadPalette(): Promise<PaletteModule> {
    if (paletteModule !== null) return paletteModule;
    const request = loadPaletteModule().then((module) => {
      Palette ??= module.default;
      return module;
    });
    paletteModule = request;
    void request.catch((error: unknown) => {
      // Forget the failure so the next focus, hover, or press tries again.
      if (paletteModule === request) paletteModule = null;
      console.error('[cinder playground] failed to load the component search palette:', error);
    });
    return request;
  }

  function preloadPalette(): void {
    void loadPalette().catch(() => undefined);
  }

  function triggerButton(): HTMLElement | null {
    return container?.querySelector('button') ?? null;
  }

  async function openPalette(focusTarget: HTMLElement | null): Promise<void> {
    if (isOpen || opening) return;
    opening = true;
    try {
      await loadPalette();
      // Mount first; the palette's dialog must exist before `open` flips.
      await tick();
      returnFocusTo = focusTarget;
      isOpen = true;
    } catch {
      // Already reported by loadPalette.
    } finally {
      opening = false;
    }
  }

  /** The shortcut returns focus to whatever had it, or to the trigger when nothing did. */
  function shortcutFocusTarget(): HTMLElement | null {
    const active = document.activeElement;
    if (active instanceof HTMLElement && active !== document.body) return active;
    return triggerButton();
  }

  $effect(() => {
    const onKeydown = (event: KeyboardEvent): void => {
      if (!isComponentSearchShortcut(event, document)) return;
      event.preventDefault();
      void openPalette(shortcutFocusTarget());
    };
    window.addEventListener('keydown', onKeydown);
    return () => window.removeEventListener('keydown', onKeydown);
  });

  /*
   * Runs after the listener effect above, so the attribute only ever appears
   * while the listener is attached. It tells the landing entry's pre-hydration
   * listener that this one now owns the shortcut: that listener keeps handling
   * presses until then, so none falls between hydration and this attaching.
   */
  $effect(() => {
    const trigger = triggerButton();
    if (trigger === null) return;
    trigger.setAttribute(COMPONENT_SEARCH_LISTENING_ATTRIBUTE, '');
    return () => trigger.removeAttribute(COMPONENT_SEARCH_LISTENING_ATTRIBUTE);
  });
</script>

<div class="dx-nav__search" bind:this={container}>
  <Button
    variant="secondary"
    size="sm"
    label={COMPONENT_SEARCH_LABEL}
    aria-haspopup="dialog"
    aria-keyshortcuts="Meta+K Control+K"
    {...{ [COMPONENT_SEARCH_TRIGGER_ATTRIBUTE]: '' }}
    onfocus={preloadPalette}
    onpointerenter={preloadPalette}
    onclick={(event: MouseEvent) => void openPalette(event.currentTarget as HTMLElement)}
  >
    {#snippet leadingIcon()}
      <Search size={15} strokeWidth={1.75} aria-hidden="true" />
    {/snippet}
  </Button>
</div>

{#if Palette !== null}
  <Palette bind:open={isOpen} {components} {returnFocusTo} />
{/if}

<style>
  .dx-nav__search {
    padding: 0 var(--cinder-space-4) var(--cinder-space-2);
  }

  .dx-nav__search :global(.cinder-button) {
    width: 100%;
    justify-content: flex-start;
  }
</style>

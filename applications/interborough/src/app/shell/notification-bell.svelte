<script lang="ts">
  /**
   * Notification bell + dropdown: what needs the person (a tool waiting for approval, a question,
   * a failed run) and what finished in a chat they are not looking at. One flat row per item, the
   * sentence first and the chat or schedule it is about after it, never a run. The badge counts
   * what needs the person; an answer is listed but does not count. The critical strip below the
   * header is a sibling component (`./critical-alert-strip.svelte`) fed by the same store.
   *
   * Built on Cinder's `Popover`, the component for a non-menu panel anchored to a button: it
   * supplies the trigger's `aria-expanded`, focus, Escape, click-outside and positioning. A
   * `Dropdown` would set `role="menu"`, which forbids the links and the button a panel of
   * notifications holds. Cinder has no one-line notification row (`StackedListItem` is a two-line
   * row), so the row is a plain anchor over the store's items.
   */
  import { Button, Popover, VisuallyHidden } from '@lostgradient/cinder';
  import type { LucideIcon } from '@lucide/svelte';
  import {
    Bell,
    CircleX,
    MessageCircleCheck,
    MessageCircleQuestionMark,
    PlugZap,
    ShieldQuestionMark,
    TriangleAlert,
  } from '@lucide/svelte';

  import { formatRelativeTime } from '../../lib/format/index.ts';
  import IdentifierText from '../../lib/identifier-text.svelte';
  import { router } from '../../lib/router.svelte.ts';
  import { NOTIFICATION_COPY } from '../copy.ts';
  import type { NotificationItem, NotificationStore } from '../notifications.svelte.ts';

  interface NotificationBellProps {
    store: NotificationStore;
  }

  let { store }: NotificationBellProps = $props();

  let open = $state(false);

  /** Icon per `NotificationEntry` icon name. `@lucide/svelte` icons are Svelte 5 components typed `LucideIcon`. */
  const ICONS: Readonly<Record<string, LucideIcon>> = {
    'shield-question-mark': ShieldQuestionMark,
    'message-circle-question-mark': MessageCircleQuestionMark,
    'message-circle-check': MessageCircleCheck,
    'circle-x': CircleX,
    'plug-zap': PlugZap,
    'triangle-alert': TriangleAlert,
  };

  function iconFor(name: string): LucideIcon {
    return ICONS[name] ?? TriangleAlert;
  }

  function goTo(item: NotificationItem): void {
    store.markRead(item.id);
    router.navigate(item.href);
    open = false;
  }
</script>

<Popover
  bind:open
  placement="bottom-end"
  label={NOTIFICATION_COPY.panelTitle}
  class="weft-notification-popover"
>
  {#snippet trigger()}
    <Button
      variant="ghost"
      iconOnly
      aria-label={NOTIFICATION_COPY.bellLabel(store.unreadCount)}
      onclick={() => (open = !open)}
    >
      <span class="weft-notification-bell__icon">
        <Bell aria-hidden="true" size={16} />
        {#if store.unreadCount > 0}
          <span class="weft-notification-bell__count" aria-hidden="true">{store.unreadCount}</span>
        {/if}
      </span>
    </Button>
  {/snippet}

  <div class="weft-notification-panel">
    <div class="weft-notification-panel__header">
      <span class="weft-notification-panel__title">{NOTIFICATION_COPY.panelTitle}</span>
      <button
        type="button"
        class="weft-notification-panel__mark-read"
        onclick={() => store.markAllRead()}
      >
        {NOTIFICATION_COPY.markAllRead}
      </button>
    </div>

    <div class="weft-notification-panel__list">
      {#each store.items as item (item.id)}
        {@const Icon = iconFor(item.icon)}
        <a
          href={router.href(item.href)}
          class="weft-notification-panel__item"
          data-tier={item.tier}
          data-kind={item.kind}
          data-read={item.read}
          onclick={(event) => {
            event.preventDefault();
            goTo(item);
          }}
        >
          <Icon aria-hidden="true" size={14} class="weft-notification-panel__item-icon" />
          <span class="weft-notification-panel__item-text">
            <span class="weft-notification-panel__item-title"
              ><IdentifierText text={item.title} /></span
            >
            <VisuallyHidden>{item.joiner}</VisuallyHidden>
            <span class="weft-notification-panel__item-detail">{item.detail}</span>
          </span>
          <span class="weft-notification-panel__item-time">
            {formatRelativeTime(item.emittedAtMs)}
          </span>
        </a>
      {/each}

      {#if store.items.length === 0}
        <p class="weft-notification-panel__empty">{NOTIFICATION_COPY.empty}</p>
      {/if}
    </div>
  </div>
</Popover>

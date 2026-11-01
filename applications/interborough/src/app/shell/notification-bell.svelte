<script lang="ts">
  /**
   * Notification bell + dropdown: what needs the person (a tool waiting for approval, a question,
   * a failed run) and what finished in a chat they are not looking at. One flat row per item, the
   * sentence first and the chat or schedule it is about after it, never a run. The badge counts
   * what needs the person; an answer is listed but does not count. The critical strip below the
   * header is a sibling component (`./critical-alert-strip.svelte`) fed by the same store.
   *
   * A list that could not be read says so instead of reading as empty, and a mark-as-read the
   * Bureau refused says the items are unread again. The panel ends with where notifications are set
   * up: their settings, and Hooks for email or webhooks.
   *
   * Built on Cinder's `Popover`, the component for a non-menu panel anchored to a button: it
   * supplies the trigger's `aria-expanded`, focus, Escape, click-outside and positioning. A
   * `Dropdown` would set `role="menu"`, which forbids the links and the button a panel of
   * notifications holds. Cinder has no one-line notification row (`StackedListItem` is a two-line
   * row), so the row is a plain anchor over the store's items.
   */
  import { Alert, Button, EmptyState, Popover, VisuallyHidden } from '@lostgradient/cinder';
  import type { LucideIcon } from '@lucide/svelte';
  import {
    Bell,
    CalendarX,
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
  import { NOTIFICATION_COPY, RETRY_LABEL } from '../copy.ts';
  import type { NotificationItem, NotificationStore } from '../notifications.svelte.ts';

  interface NotificationBellProps {
    store: NotificationStore;
  }

  let { store }: NotificationBellProps = $props();

  let open = $state(false);

  /** Where the Bureau's settings are, among them how long a notification is kept. */
  const NOTIFICATION_SETTINGS_PATH = '/settings';
  /** Where a hook sends an event as a webhook, or as email through one. */
  const HOOKS_PATH = '/hooks';

  /** Icon per `NotificationEntry` icon name. `@lucide/svelte` icons are Svelte 5 components typed `LucideIcon`. */
  const ICONS: Readonly<Record<string, LucideIcon>> = {
    'shield-question-mark': ShieldQuestionMark,
    'message-circle-question-mark': MessageCircleQuestionMark,
    'message-circle-check': MessageCircleCheck,
    'circle-x': CircleX,
    'calendar-x': CalendarX,
    'plug-zap': PlugZap,
    'triangle-alert': TriangleAlert,
  };

  function iconFor(name: string): LucideIcon {
    return ICONS[name] ?? TriangleAlert;
  }

  /** Where a link at the foot of the panel goes. */
  function followLink(event: MouseEvent, path: string): void {
    event.preventDefault();
    router.navigate(path);
    open = false;
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
      class="weft-shell-topbar-control"
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
    <div class="weft-notification-panel__bar">
      <span class="weft-notification-panel__title">{NOTIFICATION_COPY.panelTitle}</span>
      <Button variant="ghost" size="sm" data-changes onclick={() => store.markAllRead()}>
        {NOTIFICATION_COPY.markAllRead}
      </Button>
    </div>

    {#if store.loadFailed}
      <Alert variant="danger" class="weft-notification-panel__alert">
        <p class="weft-notification-panel__alert-title">{NOTIFICATION_COPY.loadFailed.title}</p>
        <p>{NOTIFICATION_COPY.loadFailed.description}</p>
        <Button variant="secondary" size="sm" onclick={() => store.reload()}>{RETRY_LABEL}</Button>
      </Alert>
    {/if}
    {#if store.readFailed}
      <Alert variant="warning" class="weft-notification-panel__alert">
        {NOTIFICATION_COPY.readFailed}
      </Alert>
    {/if}

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
              ><IdentifierText text={item.title} identifiers={item.identifiers} /></span
            >
            <VisuallyHidden>{item.joiner}</VisuallyHidden>
            <span class="weft-notification-panel__item-detail">{item.detail}</span>
          </span>
          <span class="weft-notification-panel__item-time">
            {formatRelativeTime(item.emittedAtMs)}
          </span>
        </a>
      {/each}

      {#if store.items.length === 0 && !store.loadFailed}
        <EmptyState
          kind="done"
          headingLevel={2}
          title={NOTIFICATION_COPY.empty.title}
          description={NOTIFICATION_COPY.empty.description}
        />
      {/if}
    </div>

    <nav class="weft-notification-panel__links" aria-label={NOTIFICATION_COPY.linksLabel}>
      <a
        href={router.href(NOTIFICATION_SETTINGS_PATH)}
        onclick={(event) => followLink(event, NOTIFICATION_SETTINGS_PATH)}
        >{NOTIFICATION_COPY.settingsLink}</a
      >
      <a href={router.href(HOOKS_PATH)} onclick={(event) => followLink(event, HOOKS_PATH)}
        >{NOTIFICATION_COPY.hooksLink}</a
      >
    </nav>
  </div>
</Popover>

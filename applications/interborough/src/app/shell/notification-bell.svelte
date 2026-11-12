<script lang="ts">
  /**
   * Notification bell + popover (design rows 02w and 02x): what needs the person (a tool waiting
   * for approval, a question, a failed run, a schedule that missed runs) and what finished in a
   * chat they are not looking at. The bell carries a dot while anything is unread; the popover is
   * titled "Notifications 3 unread", lists what waits on the person first, then failures and
   * missed schedules, and tints the unread rows. A row is a sentence, a second line that says what
   * kind of wait it is and whose it is, and how long ago. The critical strip below the header is a
   * sibling component (`./critical-alert-strip.svelte`) fed by the same store.
   *
   * A list that could not be read says so instead of reading as empty, and a mark-as-read the
   * Bureau refused says the items are unread again. The panel ends with where notifications are set
   * up: their settings, and Hooks for email or webhooks.
   *
   * Built on Cinder's `Popover`, the component for a non-menu panel anchored to a button: it
   * supplies the trigger's `aria-expanded`, focus, Escape, click-outside and positioning, and below
   * 640px it opens as a bottom sheet. A `Dropdown` would set `role="menu"`, which forbids the links
   * and the button a panel of notifications holds. Cinder's `StackedListItem` is a status-first
   * list row for pages; a popover row with an icon tile and an unread mark is not that shape, so
   * the row is a plain anchor over the store's items.
   */
  import { Alert, Button, EmptyState, formatCompactAge, Popover } from '@lostgradient/cinder';
  import type { LucideIcon } from '@lucide/svelte';
  import {
    Bell,
    CalendarX,
    CircleX,
    MessageCircleQuestionMark,
    PlugZap,
    ShieldQuestionMark,
    TriangleAlert,
  } from '@lucide/svelte';

  import { router } from '../../lib/router.svelte.ts';
  import { NOTIFICATION_COPY } from '../copy/shell.ts';
  import { RETRY_LABEL } from '../copy/views.ts';
  import type { NotificationItem, NotificationStore } from '../notifications.svelte.ts';

  interface NotificationBellProps {
    store: NotificationStore;
  }

  let { store }: NotificationBellProps = $props();

  let open = $state(false);

  /** The popover's title, with how many are unread: "Notifications 3 unread". */
  const panelTitle = $derived(
    store.unreadCount > 0
      ? `${NOTIFICATION_COPY.panelTitle} ${NOTIFICATION_COPY.unreadSummary(store.unreadCount)}`
      : NOTIFICATION_COPY.panelTitle,
  );

  /** Where the Bureau's settings are, among them how long a notification is kept. */
  const NOTIFICATION_SETTINGS_PATH = '/settings';
  /** Where a hook sends an event as a webhook, or as email through one. */
  const HOOKS_PATH = '/hooks';

  /** Icon per `NotificationEntry` icon name. `@lucide/svelte` icons are Svelte 5 components typed `LucideIcon`. */
  const ICONS: Readonly<Record<string, LucideIcon>> = {
    'shield-question-mark': ShieldQuestionMark,
    'message-circle-question-mark': MessageCircleQuestionMark,
    'circle-x': CircleX,
    'calendar-x': CalendarX,
    'plug-zap': PlugZap,
    'triangle-alert': TriangleAlert,
  };

  function iconFor(name: string): LucideIcon {
    return ICONS[name] ?? TriangleAlert;
  }

  /**
   * The tint of a row's icon tile: a question is information (sky), a firing rule and anything
   * that needs a decision or failed is a warning (amber), a critical item is danger (red), and
   * anything else is neutral.
   */
  function toneOf(item: NotificationItem): 'info' | 'warning' | 'danger' | 'neutral' {
    if (item.kind === 'question') return 'info';
    if (item.kind === 'alert') return 'warning';
    if (item.tier === 'critical') return 'danger';
    return item.tier === 'warning' ? 'warning' : 'neutral';
  }

  /**
   * Whether a row is drawn unread: tinted, with its dot. It is the rows the title counts, so an
   * standing item, which is listed but never counts, is not.
   */
  function isUnread(item: NotificationItem): boolean {
    return !item.read && item.tier !== 'info';
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

<Popover bind:open placement="bottom-end" label={panelTitle} class="weft-notification-popover">
  {#snippet trigger()}
    <Button
      variant="ghost"
      iconOnly
      quiet
      class="weft-shell-topbar-control"
      aria-label={NOTIFICATION_COPY.bellLabel(store.unreadCount)}
      onclick={() => (open = !open)}
    >
      <span class="weft-notification-bell__icon">
        <Bell aria-hidden="true" size={16} />
        {#if store.unreadCount > 0}
          <span class="weft-notification-bell__dot" aria-hidden="true"></span>
        {/if}
      </span>
    </Button>
  {/snippet}

  <div class="weft-notification-panel">
    <div class="weft-notification-panel__bar">
      <h2 class="weft-notification-panel__title">
        {NOTIFICATION_COPY.panelTitle}{#if store.unreadCount > 0}{' '}<span
            class="weft-notification-panel__unread"
            >{NOTIFICATION_COPY.unreadSummary(store.unreadCount)}</span
          >{/if}
      </h2>
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
          data-read={!isUnread(item)}
          onclick={(event) => {
            event.preventDefault();
            goTo(item);
          }}
        >
          <span class="weft-notification-panel__item-mark">
            {#if isUnread(item)}
              <span
                class="weft-notification-panel__item-dot"
                role="img"
                aria-label={NOTIFICATION_COPY.unreadMark}
              ></span>
            {/if}
          </span>
          <span
            class="weft-notification-panel__item-tile"
            data-tone={toneOf(item)}
            aria-hidden="true"
          >
            <Icon size={14} />
          </span>
          <span class="weft-notification-panel__item-text">
            <span class="weft-notification-panel__item-title">{item.title}</span>
            <span class="weft-notification-panel__item-detail">{item.detail}</span>
          </span>
          <span class="weft-notification-panel__item-time">
            {formatCompactAge(item.emittedAtMs)}
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

<script lang="ts" module>
  /**
   * @cinder
   * @category data-display
   * @status stable
   * @purpose Compact non-interactive label that annotates an adjacent element with a short status, count, or category.
   * @tag billing
   * @tag label
   * @tag indicator
   * @tag subscription
   * @useWhen Annotating a value with a short status word like "new" or "beta".
   * @useWhen Displaying a numeric count next to an icon or title.
   * @useWhen Displaying the billing state of a subscription in a dashboard, invoice list, or account settings page.
   * @useWhen Annotating a plan name, customer row, or invoice line with its current payment lifecycle state.
   * @avoidWhen The label must be interactive or removable — use chip instead.
   * @avoidWhen Showing only a colored dot for presence — use status-dot instead.
   * @avoidWhen Showing label and value metadata for a record, such as an owner, a date or a price — use description-list instead.
   * @related chip, status-dot
   */
  export type { BadgeProps, BadgeSeverity, BadgeSize, BadgeVariant } from './badge.types.ts';
</script>

<script lang="ts">
  import Archive from '@lucide/svelte/icons/archive';
  import CircleCheck from '@lucide/svelte/icons/circle-check';
  import CircleX from '@lucide/svelte/icons/circle-x';
  import Clock from '@lucide/svelte/icons/clock';
  import TriangleAlert from '@lucide/svelte/icons/triangle-alert';
  import Undo2 from '@lucide/svelte/icons/undo-2';

  import type { Attachment } from 'svelte/attachments';

  import { classNames } from '../../utilities/class-names.ts';

  import type { BadgeProps, BadgeSubscriptionState, BadgeVariant } from './badge.types.ts';

  type SubscriptionStateConfiguration = {
    variant: BadgeVariant;
    label: string;
  };

  const subscriptionStateConfigurations: Record<
    BadgeSubscriptionState,
    SubscriptionStateConfiguration
  > = {
    active: { variant: 'success', label: 'Active' },
    trialing: { variant: 'info', label: 'Trialing' },
    'past-due': { variant: 'warning', label: 'Past due' },
    canceled: { variant: 'neutral', label: 'Canceled' },
    expired: { variant: 'danger', label: 'Expired' },
    refunded: { variant: 'neutral', label: 'Refunded' },
  };

  let {
    variant = 'neutral',
    size = 'md',
    monospace = false,
    truncate = false,
    subscriptionState,
    severity,
    class: customClassName,
    children,
    ...rest
  }: BadgeProps = $props();

  // A truncating badge holds its whole label in the title, read from the rendered text so a snippet
  // needs no second copy of its string; the attachment keeps it current when the label changes.
  let labelText = $state<string | undefined>();
  const readLabelText: Attachment<HTMLElement> = (element) => {
    const read = (): void => {
      const text = element.textContent?.trim();
      labelText = text === undefined || text === '' ? undefined : text;
    };
    read();
    const observer = new MutationObserver(read);
    observer.observe(element, { childList: true, characterData: true, subtree: true });
    return () => observer.disconnect();
  };

  const subscriptionStateConfiguration = $derived(
    subscriptionState === undefined
      ? undefined
      : subscriptionStateConfigurations[subscriptionState],
  );
  const severityVariant = $derived<BadgeVariant | undefined>(
    severity === 'critical'
      ? undefined
      : severity === 'info'
        ? 'info'
        : severity === 'low'
          ? 'success'
          : severity === 'medium'
            ? 'warning'
            : severity === 'high'
              ? 'danger'
              : undefined,
  );
</script>

<span
  class={classNames('cinder-badge', customClassName)}
  data-cinder-variant={subscriptionStateConfiguration?.variant ?? severityVariant ?? variant}
  data-cinder-severity={subscriptionState === undefined ? severity : undefined}
  data-cinder-size={size}
  data-cinder-monospace={monospace ? '' : undefined}
  data-cinder-truncate={truncate ? '' : undefined}
  data-cinder-subscription-state={subscriptionState}
  {...rest}
>
  {#if subscriptionStateConfiguration}
    {#if subscriptionState === 'active'}
      <CircleCheck class="cinder-icon-sm" aria-hidden="true" />
    {:else if subscriptionState === 'trialing'}
      <Clock class="cinder-icon-sm" aria-hidden="true" />
    {:else if subscriptionState === 'past-due'}
      <TriangleAlert class="cinder-icon-sm" aria-hidden="true" />
    {:else if subscriptionState === 'canceled'}
      <CircleX class="cinder-icon-sm" aria-hidden="true" />
    {:else if subscriptionState === 'expired'}
      <Archive class="cinder-icon-sm" aria-hidden="true" />
    {:else if subscriptionState === 'refunded'}
      <Undo2 class="cinder-icon-sm" aria-hidden="true" />
    {/if}
    {#if children}
      {@render children()}
    {:else}
      {subscriptionStateConfiguration.label}
    {/if}
  {:else if truncate}
    <span class="cinder-badge__label" title={labelText} {@attach readLabelText}
      >{@render children?.()}</span
    >
  {:else}
    {@render children?.()}
  {/if}
</span>

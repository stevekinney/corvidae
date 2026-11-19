<script lang="ts">
  import {
    Avatar,
    Button,
    ErrorState,
    GroupedList,
    GroupedListItem,
    StatusDot,
  } from '@lostgradient/cinder';
</script>

<div style="position: relative; max-inline-size: 28rem;">
  <GroupedList header="Runs" footer="Runs older than a week are archived.">
    <GroupedListItem href="/runs/1">
      {#snippet lead()}45 min left{/snippet}
      {#snippet title()}Nightly backup{/snippet}
      {#snippet subtitle()}Running{/snippet}
      {#snippet action()}<Button size="sm" variant="ghost" aria-label="Pause">Pause</Button
        >{/snippet}
    </GroupedListItem>
    <GroupedListItem href="/runs/2">
      {#snippet lead()}9:30{/snippet}
      {#snippet title()}Index rebuild{/snippet}
      {#snippet subtitle()}Scheduled{/snippet}
      {#snippet trailing()}A longer trailing value{/snippet}
      {#snippet action()}<Button size="sm" variant="ghost" aria-label="Run now">Run</Button
        >{/snippet}
    </GroupedListItem>
  </GroupedList>

  <!-- Time-led rows beside a basic row: the lead's number sits on the title's first line, and the
       title and subtitle are the basic row's own. -->
  <GroupedList header="Open now" data-testid="grouped-list-timed">
    <GroupedListItem href="/places/basic" data-testid="row-basic">
      {#snippet title()}The Rooftop{/snippet}
      {#snippet subtitle()}Half-price wells until 8:00 pm{/snippet}
      {#snippet trailing()}0.4 mi{/snippet}
    </GroupedListItem>
    <GroupedListItem
      href="/places/rooftop"
      timeWindow="3–6 pm"
      timeCaption="12 min left"
      urgency="urgent"
      data-testid="timed-urgent"
    >
      {#snippet title()}The Rooftop{/snippet}
      {#snippet subtitle()}Half-price wells until 8:00 pm{/snippet}
      {#snippet trailing()}0.4 mi{/snippet}
    </GroupedListItem>
    <GroupedListItem
      href="/places/lantern"
      timeWindow="10 pm–1 am"
      timeCaption="starts in 1 h"
      urgency="soon"
      data-testid="timed-soon"
    >
      {#snippet title()}Lantern Room, which has a much longer name that wraps onto a second line{/snippet}
      {#snippet subtitle()}Two-dollar drafts{/snippet}
      {#snippet trailing()}1.2 mi{/snippet}
    </GroupedListItem>
    <GroupedListItem href="/places/pier" timeWindow="All day" staleAge="3d">
      {#snippet title()}The Pier{/snippet}
      {#snippet subtitle()}Oysters and rosé{/snippet}
    </GroupedListItem>
    <GroupedListItem
      href="/places/corner"
      timeWindow="11 pm–2 am"
      timeCaption="Sun to Tue"
      data-testid="timed-plain"
    >
      {#snippet title()}Corner Bar{/snippet}
    </GroupedListItem>
  </GroupedList>

  <!-- COR-2443 AC4, COR-2503 AC5 and AC6: time-led rows in a 390px phone and a 360px pane, with a
       long meta value. The name leads; the meta shares its line, or takes one of its own, before
       the name is squeezed. -->
  <div style="inline-size: 390px;" data-testid="grouped-list-timed-phone">
    <GroupedList header="Open now">
      <GroupedListItem
        href="/places/widest"
        timeWindow="11 pm–2 am"
        timeCaption="1 h 45 min left"
        data-testid="timed-widest"
      >
        {#snippet title()}Union Station Bar and Grill{/snippet}
        {#snippet subtitle()}Half-price wells, two-dollar drafts and a long second line of copy{/snippet}
        {#snippet trailing()}0.4 mi{/snippet}
      </GroupedListItem>
      <GroupedListItem
        href="/places/longmeta"
        timeWindow="4–6:30 pm"
        timeCaption="starts in 1 h"
        data-testid="timed-long-meta"
      >
        {#snippet title()}Lantern Room{/snippet}
        {#snippet subtitle()}Two-dollar drafts{/snippet}
        {#snippet trailing()}Closed Mondays and Tuesdays{/snippet}
      </GroupedListItem>
      <!-- A photo sits at the end, after the distance; nothing else in the row moves. -->
      <GroupedListItem
        href="/places/photo"
        timeWindow="3–6 pm"
        timeCaption="45 min left"
        data-testid="timed-photo-phone"
      >
        {#snippet title()}Larimer Lantern{/snippet}
        {#snippet subtitle()}Eight-dollar classics and six-dollar house wine{/snippet}
        {#snippet trailing()}0.2 mi{/snippet}
        {#snippet photo()}<span
            role="img"
            aria-label="Photo of Larimer Lantern"
            style="display: block; inline-size: 100%; block-size: 100%; background: var(--cinder-accent-solid);"
          ></span>{/snippet}
      </GroupedListItem>
    </GroupedList>
  </div>

  <!-- The desktop list (570px wide): the window two steps over the name in a 104px lead, the
       distance in a trailing column, two deals at once, a stale row past midnight with its
       distance, and a photo at the end. It stands beside the column, at the top, so the desktop
       screenshot shows all three rows; the 28rem column would cap it and push it below the fold. -->
  <div
    style="position: absolute; inset-block-start: 0; inset-inline-start: calc(100% + 1.5rem); inline-size: 570px;"
    data-testid="grouped-list-timed-wide"
  >
    <GroupedList header="Open now">
      <GroupedListItem
        href="/places/two"
        timeWindow="5–7 pm"
        timeCaption="1 h 45 min left"
        data-testid="timed-wide-two-deals"
      >
        {#snippet title()}The Gilded Pickle{/snippet}
        {#snippet subtitle()}Half-price oysters<br />Seven-dollar spritzes{/snippet}
        {#snippet trailing()}0.4 mi{/snippet}
      </GroupedListItem>
      <GroupedListItem
        href="/places/stale"
        timeWindow="11 pm–2 am"
        timeCaption="1 h 30 min left"
        staleAge="11 wk"
        data-testid="timed-wide-stale"
      >
        {#snippet title()}Sunken Ship{/snippet}
        {#snippet subtitle()}Late night: three-dollar PBR{/snippet}
        {#snippet trailing()}1.3 mi{/snippet}
      </GroupedListItem>
      <GroupedListItem
        href="/places/photo-wide"
        timeWindow="3–6 pm"
        timeCaption="45 min left"
        data-testid="timed-photo-wide"
      >
        {#snippet title()}Larimer Lantern{/snippet}
        {#snippet subtitle()}Eight-dollar classics and six-dollar house wine{/snippet}
        {#snippet trailing()}0.2 mi{/snippet}
        {#snippet photo()}<span
            role="img"
            aria-label="Photo of Larimer Lantern"
            style="display: block; inline-size: 100%; block-size: 100%; background: var(--cinder-accent-solid);"
          ></span>{/snippet}
      </GroupedListItem>
    </GroupedList>
  </div>

  <!-- Text actions (COR-2329): trailing buttons, full width under the text on a phone. -->
  <GroupedList aria-label="Waiting on you" data-testid="grouped-list-actions">
    <GroupedListItem actions={[{ label: 'Answer', href: '/reviews/1', changes: true }]}>
      {#snippet title()}Which environment should the release go to?{/snippet}
      {#snippet subtitle()}Question, Request human input, waiting 3 h{/snippet}
    </GroupedListItem>
    <GroupedListItem actions={[{ label: 'View run', href: '/runs/7' }]}>
      {#snippet title()}Nightly backup{/snippet}
      {#snippet subtitle()}<StatusDot word="Running" />, Schedule, started 10:42 AM{/snippet}
    </GroupedListItem>
  </GroupedList>

  <!-- Trailing values (COR-2329): one line, on the title's line, the subtitle under both on a phone. -->
  <GroupedList aria-label="Recent chats" data-testid="grouped-list-trailing">
    <GroupedListItem href="/chats/1">
      {#snippet title()}Please refund order 4471, it arrived damaged.{/snippet}
      {#snippet subtitle()}<StatusDot word="Waiting on you" />, I found order 4471 ($42.00). I need
        your approval to refund it.{/snippet}
      {#snippet trailing()}10:42 AM{/snippet}
    </GroupedListItem>
    <GroupedListItem href="/chats/2">
      {#snippet title()}Say hello{/snippet}
      {#snippet subtitle()}<StatusDot word="Done" />, Hello! How can I help?{/snippet}
      {#snippet trailing()}Yesterday, 4:12 PM{/snippet}
    </GroupedListItem>
    <!-- A title alone in a row the 44px minimum makes taller, and a row beside an avatar. -->
    <GroupedListItem href="/reviews" data-testid="row-title-only">
      {#snippet title()}2 more in Reviews{/snippet}
    </GroupedListItem>
    <GroupedListItem href="/people/ada" data-testid="row-avatar">
      {#snippet leading()}<Avatar name="Ada Lovelace" />{/snippet}
      {#snippet title()}Ada Lovelace{/snippet}
      {#snippet trailing()}Online{/snippet}
    </GroupedListItem>
  </GroupedList>

  <!-- A list's failed row (COR-2329): its action ends on the list buttons' edge. An empty list
  draws Cinder's one EmptyState layout instead of a row (owner report, 2026-11-19). -->
  <div data-testid="grouped-list-error-row">
    <ErrorState
      variant="row"
      headingLevel={3}
      title="Couldn’t load system problems."
      description="The rest of Home is live."
      onRetry={() => {}}
    />
  </div>
</div>

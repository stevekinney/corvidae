<script lang="ts" module>
  export const title = 'Phone form and a long current page';
  export const description =
    'Below collapseBelow (640px by default) the trail is a back link labelled with the parent ("Back to Chat") and the current page, which truncates first. A popover on the current page draws it as a button that truncates at 300px and keeps the full title in the popover. This example sets collapseBelow wide enough to show the phone form at any width.';
</script>

<script lang="ts">
  import { Breadcrumbs } from '@lostgradient/cinder';

  const title =
    'Please refund order 4471, it arrived damaged, and also check whether the Parcelly damage claims batch from last week was filed for the same carrier';
</script>

<div style="display: grid; gap: 1.5rem;">
  <Breadcrumbs
    separator="›"
    items={[
      { label: 'Chat', href: '/chat' },
      { label: title, popover: true },
    ]}
    collapseBelow={false}
  />
  <Breadcrumbs
    collapseBelow="9999px"
    items={[{ label: 'Runs', href: '/runs' }, { label: 'Look up order 4472' }]}
  />
</div>

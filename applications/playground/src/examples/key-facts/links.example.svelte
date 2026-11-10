<script lang="ts" module>
  export const title = 'A fact that links';
  export const description = 'Pass href to make a value a link. The fact still wraps as a whole.';
</script>

<script lang="ts">
  import { KeyFacts } from '@lostgradient/cinder';
</script>

<div style="max-width: 14rem;">
  <KeyFacts
    items={[
      { label: 'Kind', value: 'Cocktail bar' },
      { label: 'Neighborhood', value: 'Lower Downtown', href: '/neighborhoods/lodo' },
      { label: 'Price', value: '$$' },
    ]}
  />
</div>

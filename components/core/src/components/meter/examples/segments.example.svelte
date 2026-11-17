<script lang="ts" module>
  export const title = 'Stacked shares with a legend';
  export const description =
    'Break one reading into named shares, such as what fills a context window, with the room that is left.';
</script>

<script lang="ts">
  import { Meter, Text } from '@lostgradient/cinder';
</script>

<div style="display: grid; gap: 0.5rem; max-inline-size: 20rem;">
  <Text as="h4" variant="h5">76K of 200K tokens</Text>
  <Meter
    max={200_000}
    segments={[
      { label: 'Instructions and tools', value: 28_000, valueLabel: '28K' },
      { label: 'Conversation', value: 33_000, valueLabel: '33K' },
      { label: 'Tool results', value: 15_000, valueLabel: '15K' },
    ]}
    remainder={{ label: 'Free', valueLabel: '124K' }}
    ariaLabel="Context"
    ariaValueText="76K of 200K tokens"
  />
  <Text variant="caption">Used in total: 118,400 tokens, $0.31</Text>
</div>

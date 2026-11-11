<script lang="ts" module>
  export const title = 'Shadow cards';
  export const description =
    'edge="shadow" swaps the hairline border of each `cards` stat for one soft shadow. A card draws one edge, never both.';
</script>

<script lang="ts">
  import { StatisticGroup } from '@lostgradient/cinder';
</script>

<StatisticGroup label="Home" columns={4} variant="cards" edge="shadow">
  <StatisticGroup.Statistic label="Running now" value={0} />
  <StatisticGroup.Statistic label="Needs you" value={2} attention />
  <StatisticGroup.Statistic label="Failed in 24 hours" value={0} />
  <StatisticGroup.Statistic label="Missed schedule runs (7 days)" value={4} attention />
</StatisticGroup>

<script lang="ts" module>
  export const title = 'Flat cards';
  export const description =
    'edge="border" keeps each card’s hairline border and drops the shadow of the `cards` variant.';
</script>

<script lang="ts">
  import { StatisticGroup } from '@lostgradient/cinder';
</script>

<StatisticGroup label="Home" columns={4} variant="cards" edge="border">
  <StatisticGroup.Statistic label="Running now" value={0} />
  <StatisticGroup.Statistic label="Needs you" value={2} attention />
  <StatisticGroup.Statistic label="Failed in 24 hours" value={0} />
  <StatisticGroup.Statistic label="Missed schedule runs (7 days)" value={4} attention />
</StatisticGroup>

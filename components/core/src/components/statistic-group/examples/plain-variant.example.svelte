<script lang="ts" module>
  export const title = 'Plain variant under a spotlight';
  export const description =
    'variant="plain" draws no surface, border, padding or divider and sets its values a step smaller, so one stat sits under a Spotlight without competing with it.';
</script>

<script lang="ts">
  import { Spotlight, StatisticGroup } from '@lostgradient/cinder';
</script>

<Spotlight value="2 need you" />
<StatisticGroup label="Home counts" columns={1} variant="plain">
  <StatisticGroup.Statistic label="Failed in 24 hours" value={3} attention />
</StatisticGroup>

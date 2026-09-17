<script lang="ts">
  import { StatisticGroup } from '@repo/cinder';
</script>

<StatisticGroup label="Workspace usage" columns="auto">
  <StatisticGroup.Statistic label="Projects" value={42} />
  <StatisticGroup.Statistic label="Members" value={18} />
  <StatisticGroup.Statistic label="Storage" value="64 GB" />
  <StatisticGroup.Statistic
    label="API calls"
    value={128400}
    valueFormatOptions={{ notation: 'compact' }}
  />
</StatisticGroup>

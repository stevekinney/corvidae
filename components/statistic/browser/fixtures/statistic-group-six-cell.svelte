<script lang="ts">
  import { default as StatisticGroup } from '@lostgradient/statistic/components/statistic-group/index.ts';
</script>

<StatisticGroup id="statistic-group-six-cell" label="Workspace usage" variant="default" columns={3}>
  <StatisticGroup.Statistic label="Projects" value={42} />
  <StatisticGroup.Statistic label="Members" value={18} />
  <StatisticGroup.Statistic label="Storage" value="64 GB" />
  <StatisticGroup.Statistic label="Builds" value={310} />
  <StatisticGroup.Statistic label="Deploys" value={97} />
  <StatisticGroup.Statistic label="Incidents" value={2} />
</StatisticGroup>

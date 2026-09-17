<script lang="ts">
  import { ApprovalCard } from '@repo/cinder';
</script>

<ApprovalCard
  tool={{ name: 'deploy-cloud', risk: 'medium' }}
  sandbox={{
    provider: 'codex',
    name: 'workspace-write',
    workingDir: '/workspace/project',
  }}
  operation={{
    kind: 'command',
    command: 'bun run --filter=@repo/cinder validate',
    filesTouched: ['packages/components/src/components/approval-card/approval-card.svelte'],
    argsPreview: {
      package: '@repo/cinder',
      dryRun: false,
    },
  }}
  env={['DATABASE_URL', 'OPENAI_API_KEY']}
  snapshotId="snapshot-01JZ8"
  policyVersion="policy-2026-06"
  idempotencyKey="approval-command-01"
  state="pending"
  editableArgs={true}
  onResolve={() => undefined}
/>

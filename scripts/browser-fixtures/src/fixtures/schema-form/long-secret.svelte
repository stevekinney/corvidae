<script lang="ts">
  import { SchemaForm } from '@lostgradient/cinder';

  // R10-13: a long saved key chosen in a secret field, in a column narrower than the key.
  const longKey = 'slack-workspace-admin-bot-token-for-the-reviews-channel';

  const schema = {
    type: 'object',
    properties: {
      channel: { type: 'string', title: 'Channel' },
      token: { type: 'string', title: 'Token', secret: true },
    },
    required: ['channel', 'token'],
  };
</script>

<div id="long-secret-column" style="inline-size: 288px;">
  <SchemaForm
    {schema}
    name="long-secret"
    value={{ channel: 'ops', token: { $secret: longKey } }}
    secrets={{
      keys: [
        { key: 'slack-bot-token', group: 'Slack', set: true },
        { key: longKey, group: 'Slack', set: true },
      ],
    }}
    submitLabel="Save hook"
  />
</div>

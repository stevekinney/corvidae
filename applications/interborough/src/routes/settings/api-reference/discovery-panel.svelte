<script lang="ts">
  /**
   * The Discovery documents tab (board PageSettingsSections, "API reference, Discovery documents"):
   * three documents other programs read, each with what it is for, its address in small monospace
   * and a Copy button named for the document ("Copy Agent card"). The OpenAPI description is
   * Interborough's own API at `/api/openapi.json`, and the tool server is at this server's own
   * address; the agent card is the host's directory card.
   */
  import { CopyButton, FormSection, SettingRow } from '@lostgradient/cinder';
  import { createQuery } from '@tanstack/svelte-query';

  import { API_REFERENCE_COPY } from '../../../app/copy/api-reference.ts';
  import { getClient } from '../../../lib/client.ts';
  import { getHostPaths } from '../../../lib/host-paths.ts';
  import { queryKeys } from '../../../lib/query.ts';
  import { discoveryDocumentUrl, discoveryOrigin } from '../../system/discovery-client.ts';

  const client = getClient();
  const copy = API_REFERENCE_COPY.discovery;

  const hostPaths = createQuery(
    () => ({
      queryKey: queryKeys.hostPaths(),
      queryFn: ({ signal }) => getHostPaths({ signal }),
      retry: false,
    }),
    undefined,
  );

  const origin = discoveryOrigin(client);

  /** The documents, in the order the board lists them. The agent card's address is the host's to say. */
  const documents = $derived([
    // Interborough's own API (`/api/openapi.json`); Weft's engine description stays at `/openapi.json`.
    { id: 'openapi', ...copy.documents.openapi, address: discoveryDocumentUrl(client, 'api') },
    {
      id: 'agent-card',
      ...copy.documents.agentCard,
      address: hostPaths.data?.a2aDirectoryUrl ?? `${origin}/.well-known/agent-card.json`,
    },
    { id: 'tools', ...copy.documents.tools, address: `${origin}/mcp` },
  ]);
</script>

<div class="ib-discovery" data-testid="api-discovery">
  <FormSection grouped>
    {#each documents as document (document.id)}
      <div class="ib-discovery__row" data-document={document.id}>
        <SettingRow
          id={`ib-discovery-${document.id}`}
          label={document.title}
          description={document.description}
          controlWidth="24rem"
        >
          {#snippet control()}
            <div class="ib-discovery__address">
              <code id={`ib-discovery-${document.id}`} class="ib-discovery__code"
                >{document.address}</code
              >
              <CopyButton
                value={document.address}
                label={copy.copy(document.title)}
                copiedLabel={copy.copied(document.title)}
                iconOnly
              />
            </div>
          {/snippet}
        </SettingRow>
      </div>
    {/each}
  </FormSection>
</div>

<style>
  .ib-discovery {
    min-inline-size: 0;
  }

  .ib-discovery__row {
    min-inline-size: 0;
  }

  .ib-discovery__address {
    display: flex;
    gap: var(--cinder-space-2);
    align-items: center;
    justify-content: flex-end;
    min-inline-size: 0;
    inline-size: 100%;
  }

  .ib-discovery__code {
    min-inline-size: 0;
    font-size: var(--cinder-text-xs);
    overflow-wrap: anywhere;
    text-align: end;
  }
</style>

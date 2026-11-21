<script lang="ts">
  /**
   * Where a kind of file lives, under a list page's empty state: a closed "Where workflow files
   * live" row that opens to the folder, with Copy. The empty state's own words never hold a path
   * (owner report, 2026-11-19), so a person who wants the folder asks for it here.
   */
  import { Collapsible, CopyableValue } from '@lostgradient/cinder';

  interface FileLocationDetailProps {
    /** The row's words, such as "Where workflow files live". */
    label: string;
    /** The sentence before the folder, such as "Add a workflow as a file in". */
    lead: string;
    /** The folder. */
    directory: string;
    /** The copy control's name. */
    copyLabel: string;
    /** What the copy control says once it has copied. */
    copiedLabel: string;
    'data-testid'?: string;
  }

  let {
    label,
    lead,
    directory,
    copyLabel,
    copiedLabel,
    'data-testid': testId,
  }: FileLocationDetailProps = $props();
</script>

<Collapsible variant="flat" trigger={label} class="ib-file-location" data-testid={testId}>
  <p class="ib-file-location__line">
    {lead}
    <CopyableValue
      value={directory}
      label={copyLabel}
      {copiedLabel}
      data-testid="file-location-directory"
    />
  </p>
</Collapsible>

<style>
  .ib-file-location__line {
    margin: 0;
    color: var(--cinder-text-muted);
    font-size: var(--cinder-text-sm);
    text-align: start;
  }
</style>

<script lang="ts">
  import { default as Dropdown } from '@lostgradient/dropdown/components/dropdown/index.ts';
  import {
    FileArchive,
    GitBranch,
    Pencil,
  } from '@lostgradient/foundation/components/icons/index.ts';

  let { showOmittedMiddle = false }: { showOmittedMiddle?: boolean } = $props();

  // COR-2327: disabled items that say why on a second line, drawn only behind a query parameter so
  // the default fixture, its baselines and its axe sweep stay as they are.
  const disabledReason =
    new URLSearchParams(globalThis.location.search).get('disabled-reason') === '1';
</script>

{#if disabledReason}
  <div id="example-mount-disabled-reason">
    <Dropdown id="dropdown-disabled-reason" placement="bottom-start">
      <Dropdown.Trigger>Chat actions</Dropdown.Trigger>
      <Dropdown.Menu>
        <Dropdown.Item>
          <Pencil aria-hidden="true" size={14} />
          Rename
        </Dropdown.Item>
        <Dropdown.Item disabled disabledReason="There is no finished reply to branch from yet.">
          <GitBranch aria-hidden="true" size={14} />
          Branch from the last reply
        </Dropdown.Item>
        <Dropdown.Item
          disabled
          disabledReason="Wait for the run to finish or stop it, then archive the chat."
        >
          <FileArchive aria-hidden="true" size={14} />
          Archive
        </Dropdown.Item>
        <Dropdown.Item disabled disabledReason="Nothing to export yet.">Export</Dropdown.Item>
      </Dropdown.Menu>
    </Dropdown>
  </div>
{/if}

<div id="example-mount-basic">
  <Dropdown id="dropdown">
    <Dropdown.Trigger>Options</Dropdown.Trigger>
    <Dropdown.Menu>
      <Dropdown.Item>Edit</Dropdown.Item>
      <Dropdown.Item>Duplicate</Dropdown.Item>
      <Dropdown.Item variant="danger">Delete</Dropdown.Item>
    </Dropdown.Menu>
  </Dropdown>
</div>
<div id="example-mount-with-label">
  <Dropdown id="dropdown-with-label">
    <Dropdown.Trigger>Grouped menu</Dropdown.Trigger>
    <Dropdown.Menu>
      <Dropdown.Group ariaLabelledby="dropdown-with-label-document">
        <Dropdown.Label id="dropdown-with-label-document">Document</Dropdown.Label>
        <Dropdown.Item>Rename</Dropdown.Item>
        <Dropdown.Item>Move</Dropdown.Item>
      </Dropdown.Group>
      <Dropdown.Group ariaLabelledby="dropdown-with-label-sharing">
        <Dropdown.Label id="dropdown-with-label-sharing">Sharing</Dropdown.Label>
        <Dropdown.Item>Copy link</Dropdown.Item>
        <Dropdown.Item>Invite people</Dropdown.Item>
      </Dropdown.Group>
    </Dropdown.Menu>
  </Dropdown>
</div>

<Dropdown id="row-regression-dropdown">
  <Dropdown.Trigger>Row regression</Dropdown.Trigger>
  <Dropdown.Menu>
    <Dropdown.Group ariaLabelledby="row-regression-group-one">
      <Dropdown.Label id="row-regression-group-one">First group</Dropdown.Label>
      <Dropdown.Item>First</Dropdown.Item>
      {#if showOmittedMiddle}<Dropdown.Item>Omitted middle</Dropdown.Item>{/if}
      <Dropdown.Item hidden>Hidden terminal</Dropdown.Item>
    </Dropdown.Group>
    <Dropdown.Separator />
    <Dropdown.Group ariaLabelledby="row-regression-group-two">
      <Dropdown.Label id="row-regression-group-two">Nested group</Dropdown.Label>
      <Dropdown.Item>Nested first</Dropdown.Item>
      <Dropdown.Item>Nested terminal</Dropdown.Item>
    </Dropdown.Group>
    <Dropdown.Separator />
    <Dropdown.Group ariaLabelledby="row-regression-group-three">
      <Dropdown.Label id="row-regression-group-three">Third group</Dropdown.Label>
      <Dropdown.Item>Third first</Dropdown.Item>
      <Dropdown.Item>Third terminal</Dropdown.Item>
    </Dropdown.Group>
  </Dropdown.Menu>
</Dropdown>

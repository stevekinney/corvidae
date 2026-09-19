<script lang="ts">
  import { Dropdown } from '@corvidae/cinder';
</script>

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

<Dropdown id="row-regression-dropdown" open>
  <Dropdown.Trigger>Row regression</Dropdown.Trigger>
  <Dropdown.Menu>
    <Dropdown.Group ariaLabelledby="row-regression-group-one">
      <Dropdown.Label id="row-regression-group-one">First group</Dropdown.Label>
      <Dropdown.Item>First</Dropdown.Item>
      {#if false}<Dropdown.Item>Omitted middle</Dropdown.Item>{/if}
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

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

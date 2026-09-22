# Tree

Hierarchical tree view for navigating or selecting nested data structures.

## Usage

`Tree` is a compound component. Import the parent and compose `Tree.Item` via the namespace API.

```svelte
<script lang="ts">
  import { Tree } from '@lostgradient/cinder';

  let expandedIds = $state<string[]>(['fruit']);
</script>

<Tree aria-label="Pantry" bind:expandedIds>
  <Tree.Item id="fruit" label="Fruit" branch>
    <Tree.Item id="apple" label="Apple" />
    <Tree.Item id="banana" label="Banana" />
  </Tree.Item>
  <Tree.Item id="grain" label="Grain" branch>
    <Tree.Item id="rice" label="Rice" />
  </Tree.Item>
</Tree>
```

The leaf remains importable individually for à-la-carte builds — see `@lostgradient/cinder`.

## Props

<!-- generated:props:start -->

| Prop | Type | Required | Default | Description |
| --- | --- | --- | --- | --- |
| `about` | `string` \| `null` | no | — |  |
| `accesskey` | `string` \| `null` | no | — |  |
| `aria-activedescendant` | `string` \| `null` | no | — |  |
| `aria-atomic` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-autocomplete` | `"none"` \| `"list"` \| `"inline"` \| `"both"` \| `null` | no | — |  |
| `aria-busy` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-checked` | `false` \| `true` \| `"true"` \| `"false"` \| `"mixed"` \| `null` | no | — |  |
| `aria-colcount` | `number` \| `null` | no | — |  |
| `aria-colindex` | `number` \| `null` | no | — |  |
| `aria-colspan` | `number` \| `null` | no | — |  |
| `aria-controls` | `string` \| `null` | no | — |  |
| `aria-current` | `false` \| `true` \| `"true"` \| `"false"` \| `"page"` \| `"step"` \| `"location"` \| `"date"` \| `"time"` \| `null` | no | — |  |
| `aria-describedby` | `string` \| `null` | no | — |  |
| `aria-details` | `string` \| `null` | no | — |  |
| `aria-disabled` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-dropeffect` | `"none"` \| `"link"` \| `"copy"` \| `"execute"` \| `"move"` \| `"popup"` \| `null` | no | — |  |
| `aria-errormessage` | `string` \| `null` | no | — |  |
| `aria-expanded` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-flowto` | `string` \| `null` | no | — |  |
| `aria-grabbed` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-haspopup` | `false` \| `true` \| `"true"` \| `"false"` \| `"dialog"` \| `"grid"` \| `"listbox"` \| `"menu"` \| `"tree"` \| `null` | no | — |  |
| `aria-hidden` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-invalid` | `false` \| `true` \| `"true"` \| `"false"` \| `"grammar"` \| `"spelling"` \| `null` | no | — |  |
| `aria-keyshortcuts` | `string` \| `null` | no | — |  |
| `aria-label` | `string` | no | — | Accessible label for the tree. One of aria-label or aria-labelledby is required. |
| `aria-labelledby` | `string` | no | — | The `id` of a visible element whose text serves as the accessible label for the tree. One of `aria-label` or `aria-labelledby` is required. |
| `aria-level` | `number` \| `null` | no | — |  |
| `aria-live` | `"off"` \| `"assertive"` \| `"polite"` \| `null` | no | — |  |
| `aria-modal` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-multiline` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-orientation` | `"horizontal"` \| `"vertical"` \| `null` | no | — |  |
| `aria-owns` | `string` \| `null` | no | — |  |
| `aria-placeholder` | `string` \| `null` | no | — |  |
| `aria-posinset` | `number` \| `null` | no | — |  |
| `aria-pressed` | `false` \| `true` \| `"true"` \| `"false"` \| `"mixed"` \| `null` | no | — |  |
| `aria-readonly` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-relevant` | `"text"` \| `"additions"` \| `"additions removals"` \| `"additions text"` \| `"all"` \| `"removals"` \| `"removals additions"` \| `"removals text"` \| `"text additions"` \| `"text removals"` \| `null` | no | — |  |
| `aria-required` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-roledescription` | `string` \| `null` | no | — |  |
| `aria-rowcount` | `number` \| `null` | no | — |  |
| `aria-rowindex` | `number` \| `null` | no | — |  |
| `aria-rowspan` | `number` \| `null` | no | — |  |
| `aria-selected` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `aria-setsize` | `number` \| `null` | no | — |  |
| `aria-sort` | `"none"` \| `"ascending"` \| `"descending"` \| `"other"` \| `null` | no | — |  |
| `aria-valuemax` | `number` \| `null` | no | — |  |
| `aria-valuemin` | `number` \| `null` | no | — |  |
| `aria-valuenow` | `number` \| `null` | no | — |  |
| `aria-valuetext` | `string` \| `null` | no | — |  |
| `autocapitalize` | `"characters"` \| `"off"` \| `"on"` \| `"none"` \| `"sentences"` \| `"words"` \| `null` | no | — |  |
| `autofocus` | `false` \| `true` \| `null` | no | — |  |
| `autosave` | `string` \| `null` | no | — |  |
| `bind:clientHeight` | `number` \| `null` | no | — |  |
| `bind:clientWidth` | `number` \| `null` | no | — |  |
| `bind:focused` | `false` \| `true` \| `null` | no | — |  |
| `bind:innerHTML` | `string` \| `null` | no | — |  |
| `bind:innerText` | `string` \| `null` | no | — |  |
| `bind:offsetHeight` | `number` \| `null` | no | — |  |
| `bind:offsetWidth` | `number` \| `null` | no | — |  |
| `bind:textContent` | `string` \| `null` | no | — |  |
| `checkboxSelection` | `boolean` | no | — | Render tree-owned checkbox indicators when selectionMode is multiple. Default: false. |
| `class` | `string` | no | — | Additional CSS class merged with `.cinder-tree`. |
| `color` | `string` \| `null` | no | — |  |
| `contenteditable` | `false` \| `true` \| `"true"` \| `"false"` \| `"inherit"` \| `"plaintext-only"` \| `null` | no | — |  |
| `contextmenu` | `string` \| `null` | no | — |  |
| `data-testid` | `string` | no | — |  |
| `datatype` | `string` \| `null` | no | — |  |
| `dir` | `"ltr"` \| `"rtl"` \| `"auto"` \| `null` | no | — |  |
| `draggable` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `elementtiming` | `string` \| `null` | no | — |  |
| `enterkeyhint` | `"enter"` \| `"done"` \| `"go"` \| `"next"` \| `"previous"` \| `"search"` \| `"send"` \| `null` | no | — |  |
| `expandedIds` | `string`[] | no | — | Currently expanded branch ids. Bindable. |
| `filterPlaceholder` | `string` | no | — | Placeholder and accessible label for the built-in search input. Default: 'Search tree'. |
| `filterValue` | `string` | no | — | Controlled filter query. When provided, matching is driven by this value. |
| `hidden` | `false` \| `true` \| `""` \| `"until-found"` \| `null` | no | — |  |
| `id` | `string` \| `null` | no | — |  |
| `inert` | `false` \| `true` \| `null` | no | — |  |
| `inputmode` | `"none"` \| `"search"` \| `"text"` \| `"tel"` \| `"url"` \| `"email"` \| `"numeric"` \| `"decimal"` \| `null` | no | — |  |
| `is` | `string` \| `null` | no | — |  |
| `itemid` | `string` \| `null` | no | — |  |
| `itemprop` | `string` \| `null` | no | — |  |
| `itemref` | `string` \| `null` | no | — |  |
| `itemscope` | `false` \| `true` \| `null` | no | — |  |
| `itemtype` | `string` \| `null` | no | — |  |
| `lang` | `string` \| `null` | no | — |  |
| `part` | `string` \| `null` | no | — |  |
| `placeholder` | `string` \| `null` | no | — |  |
| `popover` | `""` \| `"auto"` \| `"manual"` \| `"hint"` \| `null` | no | — |  |
| `prefix` | `string` \| `null` | no | — |  |
| `property` | `string` \| `null` | no | — |  |
| `radiogroup` | `string` \| `null` | no | — |  |
| `resource` | `string` \| `null` | no | — |  |
| `results` | `number` \| `null` | no | — |  |
| `searchVisible` | `boolean` | no | — | Render the built-in search input before the role="tree" element. Default: false. |
| `security` | `string` \| `null` | no | — |  |
| `selectedIds` | `string`[] | no | — | Currently selected node ids. Bindable. |
| `selectionBehavior` | `"independent"` \| `"cascade"` | no | — | Select only the target item or cascade through its selectable scope. Default: 'independent'. |
| `selectionMode` | `"none"` \| `"single"` \| `"multiple"` | no | — | Selection model. Default: 'none'. |
| `slot` | `string` \| `null` | no | — |  |
| `spellcheck` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `style` | `string` \| `null` | no | — |  |
| `title` | `string` \| `null` | no | — |  |
| `translate` | `""` \| `"yes"` \| `"no"` \| `null` | no | — |  |
| `typeaheadDisabled` | `boolean` | no | `false` | Disable typeahead. |
| `typeof` | `string` \| `null` | no | — |  |
| `unselectable` | `"off"` \| `"on"` \| `null` | no | — |  |
| `virtualizationEstimatedRowHeight` | `number` | no | — | Estimated row height for virtualized Tree rows. Default: 36. |
| `virtualizationHeight` | `string` \| `number` | no | — | Block size for the virtualized scroll viewport. Default: '20rem'. |
| `virtualizationOverscan` | `number` | no | — | Extra rows rendered before and after the viewport. Default: 4. |
| `virtualized` | `boolean` | no | — | Use the data-driven virtualized render path for large trees. Default: false. |
| `vocab` | `string` \| `null` | no | — |  |
| `writingsuggestions` | `false` \| `true` \| `"true"` \| `"false"` \| `null` | no | — |  |
| `xmlns` | `string` \| `null` | no | — |  |
| `bind:borderBoxSize` | `(opaque)` | no | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `bind:contentBoxSize` | `(opaque)` | no | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `bind:contentRect` | `(opaque)` | no | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `bind:devicePixelContentBoxSize` | `(opaque)` | no | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `children` | `(opaque)` | no | — | Tree items (snippet). Required when virtualized is false or omitted; mutually exclusive with items. Not expressible in JSON Schema; see the component types for the signature. |
| `filterPredicate` | `(opaque)` | no | — | Custom filter predicate. Default: case-insensitive label substring matching. Not expressible in JSON Schema; see the component types for the signature. |
| `inlist` | `(opaque)` | no | — | A prop whose shape is not captured by the JSON schema; see the component types for the exact signature. |
| `items` | `(opaque)` | no | — | Data-driven Tree items. Required when virtualized is true; mutually exclusive with children. Not expressible in JSON Schema; see the component types for the signature. |
| `on:abort` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:animationend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:animationiteration` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:animationstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:auxclick` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:beforeinput` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:beforematch` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:beforetoggle` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:blur` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:cancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:canplay` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:canplaythrough` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:change` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:click` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:close` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:compositionend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:compositionstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:compositionupdate` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:contentvisibilityautostatechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:contextmenu` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:copy` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:cuechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:cut` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dblclick` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:drag` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dragend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dragenter` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dragexit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dragleave` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dragover` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:dragstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:drop` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:durationchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:emptied` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:encrypted` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:ended` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:error` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:focus` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:focusin` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:focusout` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:formdata` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:fullscreenchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:fullscreenerror` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:gamepadconnected` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:gamepaddisconnected` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:gotpointercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:input` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:introend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:introstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:invalid` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:keydown` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:keypress` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:keyup` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:load` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:loadeddata` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:loadedmetadata` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:loadstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:lostpointercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:message` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:messageerror` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mousedown` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mouseenter` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mouseleave` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mousemove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mouseout` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mouseover` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:mouseup` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:outroend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:outrostart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:paste` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pause` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:play` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:playing` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointercancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointerdown` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointerenter` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointerleave` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointermove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointerout` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointerover` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:pointerup` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:progress` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:ratechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:reset` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:resize` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:scroll` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:scrollend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:seeked` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:seeking` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:select` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:selectionchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:selectstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:stalled` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:submit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:suspend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:timeupdate` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:toggle` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:touchcancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:touchend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:touchmove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:touchstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:transitioncancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:transitionend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:transitionrun` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:transitionstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:visibilitychange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:volumechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:waiting` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `on:wheel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onabort` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onabortcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onanimationend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onanimationendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onanimationiteration` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onanimationiterationcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onanimationstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onanimationstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onauxclick` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onauxclickcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onbeforeinput` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onbeforeinputcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onbeforematch` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onbeforematchcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onbeforetoggle` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onbeforetogglecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onblur` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onblurcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncancelcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncanplay` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncanplaycapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncanplaythrough` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncanplaythroughcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onchangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onclick` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onclickcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onclose` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onclosecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncompositionend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncompositionendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncompositionstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncompositionstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncompositionupdate` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncompositionupdatecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncontentvisibilityautostatechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncontentvisibilityautostatechangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncontextmenu` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncontextmenucapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncopy` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncopycapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncuechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncuechangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncut` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oncutcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondblclick` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondblclickcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondrag` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragenter` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragentercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragexit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragexitcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragleave` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragleavecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragover` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragovercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondragstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondrop` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondropcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondurationchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ondurationchangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onemptied` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onemptiedcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onencrypted` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onencryptedcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onended` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onendedcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onerror` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onerrorcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onFilterChange` | `(opaque)` | no | — | Fires whenever the built-in search input changes the filter query. Not expressible in JSON Schema; see the component types for the signature. |
| `onfocus` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfocuscapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfocusin` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfocusincapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfocusout` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfocusoutcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onformdata` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onformdatacapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfullscreenchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfullscreenchangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfullscreenerror` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onfullscreenerrorcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ongamepadconnected` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ongamepaddisconnected` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ongotpointercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ongotpointercapturecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oninput` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oninputcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onintroend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onintroendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onintrostart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onintrostartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oninvalid` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `oninvalidcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onkeydown` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onkeydowncapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onkeypress` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onkeypresscapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onkeyup` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onkeyupcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onload` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadeddata` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadeddatacapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadedmetadata` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadedmetadatacapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onloadstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onlostpointercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onlostpointercapturecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmessage` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmessagecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmessageerror` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmessageerrorcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmousedown` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmousedowncapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseenter` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseleave` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmousemove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmousemovecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseout` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseoutcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseover` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseovercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseup` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onmouseupcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onoutroend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onoutroendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onoutrostart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onoutrostartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpaste` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpastecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpause` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpausecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onplay` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onplaycapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onplaying` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onplayingcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointercancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointercancelcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerdown` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerdowncapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerenter` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerentercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerleave` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerleavecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointermove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointermovecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerout` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointeroutcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerover` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerovercapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerup` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onpointerupcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onprogress` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onprogresscapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onratechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onratechangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onReorder` | `(opaque)` | no | — | Called when a draggable item is dropped before, after, or into another tree item. Not expressible in JSON Schema; see the component types for the signature. |
| `onreset` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onresetcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onresize` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onresizecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onscroll` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onscrollcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onscrollend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onscrollendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onseeked` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onseekedcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onseeking` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onseekingcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onselect` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onselectcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onselectionchange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onselectionchangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onselectstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onselectstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onstalled` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onstalledcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onsubmit` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onsubmitcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onsuspend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onsuspendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontimeupdate` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontimeupdatecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontoggle` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontogglecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchcancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchcancelcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchmove` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchmovecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontouchstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitioncancel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitioncancelcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitionend` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitionendcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitionrun` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitionruncapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitionstart` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ontransitionstartcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onvisibilitychange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onvisibilitychangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onvolumechange` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onvolumechangecapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onwaiting` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onwaitingcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onwheel` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `onwheelcapture` | `(opaque)` | no | — | A function or snippet prop. Its shape is not captured by the JSON schema; see the component types for the exact signature. |
| `ref` | `(opaque)` | no | — | Typed programmatic handle. Use `bind:ref` to receive it. Not expressible in JSON Schema; see the component types for the signature. |
| `selectionControls` | `(opaque)` | no | — | Optional selection controls rendered before the role="tree" element. Not expressible in JSON Schema; see the component types for the signature. |
| `virtualizedItem` | `(opaque)` | no | — | Optional custom virtualized row renderer. Not expressible in JSON Schema; see the component types for the signature. |

<!-- generated:props:end -->

## CSS Variables

<!-- generated:variables:start -->

- `--cinder-tree-drop-line-color`
- `--cinder-tree-drop-line-thickness`
- `--cinder-tree-item-dragging-opacity`

<!-- generated:variables:end -->

## Subcomponents

<!-- generated:subcomponents:start -->

- `Tree.Item` — a tree node, branch or leaf; see [`tree-item`](../tree-item/README.md).
- `Tree.SelectAll` — the root-level select-all/none control. It reads Tree's selection context and is namespace-only: there is no standalone `@lostgradient/cinder` import, because rendering it outside a Tree always throws.

<!-- generated:subcomponents:end -->

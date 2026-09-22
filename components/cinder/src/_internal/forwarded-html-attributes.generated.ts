/**
 * GENERATED FILE — do not hand-edit.
 *
 * Run `bun run --filter=@lostgradient/cinder attributes:generate` to refresh
 * after a svelte upgrade. `attributes:check` — part of the default `bun
 * test` suite via `scripts/generate-forwarded-html-attributes.test.ts` —
 * fails if this drifts from what `svelte/elements` currently declares.
 *
 * See the module doc on `scripts/generate-forwarded-html-attributes.ts` for
 * why this file exists (COR-239): every type below is a flattened,
 * non-generic copy of a `svelte/elements` interface, kept byte-for-byte
 * equivalent to the original so components can forward it from more than one
 * arm of a discriminated union without tripping TS2590.
 */

export type FlatHTMLButtonAttributes = {
  disabled?: boolean | null | undefined;
  form?: string | null | undefined;
  formaction?: string | null | undefined;
  formenctype?:
    'application/x-www-form-urlencoded' | 'multipart/form-data' | 'text/plain' | null | undefined;
  formmethod?: 'dialog' | 'get' | 'post' | 'DIALOG' | 'GET' | 'POST' | null | undefined;
  formnovalidate?: boolean | null | undefined;
  formtarget?: string | null | undefined;
  name?: string | null | undefined;
  type?: 'submit' | 'reset' | 'button' | null | undefined;
  value?: string | number | string[] | null | undefined;
  popovertarget?: string | null | undefined;
  popovertargetaction?: 'toggle' | 'show' | 'hide' | null | undefined;
  command?:
    | 'show-modal'
    | 'close'
    | 'request-close'
    | 'show-popover'
    | 'hide-popover'
    | 'toggle-popover'
    | (string & {})
    | null
    | undefined;
  commandfor?: string | null | undefined;
  accesskey?: string | null | undefined;
  autocapitalize?: 'characters' | 'off' | 'on' | 'none' | 'sentences' | 'words' | null | undefined;
  autofocus?: boolean | null | undefined;
  class?: import('svelte/elements').ClassValue | null | undefined;
  contenteditable?:
    import('svelte/elements').Booleanish | 'inherit' | 'plaintext-only' | null | undefined;
  contextmenu?: string | null | undefined;
  dir?: 'ltr' | 'rtl' | 'auto' | null | undefined;
  draggable?: import('svelte/elements').Booleanish | null | undefined;
  elementtiming?: string | null | undefined;
  enterkeyhint?:
    'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send' | null | undefined;
  hidden?: boolean | '' | 'until-found' | null | undefined;
  id?: string | null | undefined;
  lang?: string | null | undefined;
  part?: string | null | undefined;
  placeholder?: string | null | undefined;
  slot?: string | null | undefined;
  spellcheck?: import('svelte/elements').Booleanish | null | undefined;
  style?: string | null | undefined;
  tabindex?: number | null | undefined;
  title?: string | null | undefined;
  translate?: '' | 'yes' | 'no' | null | undefined;
  inert?: boolean | null | undefined;
  popover?: '' | 'auto' | 'manual' | 'hint' | null | undefined;
  writingsuggestions?: import('svelte/elements').Booleanish | null | undefined;
  radiogroup?: string | null | undefined;
  role?: import('svelte/elements').AriaRole | null | undefined;
  about?: string | null | undefined;
  datatype?: string | null | undefined;
  inlist?: any;
  prefix?: string | null | undefined;
  property?: string | null | undefined;
  resource?: string | null | undefined;
  typeof?: string | null | undefined;
  vocab?: string | null | undefined;
  autosave?: string | null | undefined;
  color?: string | null | undefined;
  itemprop?: string | null | undefined;
  itemscope?: boolean | null | undefined;
  itemtype?: string | null | undefined;
  itemid?: string | null | undefined;
  itemref?: string | null | undefined;
  results?: number | null | undefined;
  security?: string | null | undefined;
  unselectable?: 'off' | 'on' | null | undefined;
  inputmode?:
    'none' | 'search' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | null | undefined;
  is?: string | null | undefined;
  'bind:innerHTML'?: string | null | undefined;
  'bind:textContent'?: string | null | undefined;
  'bind:innerText'?: string | null | undefined;
  'bind:focused'?: boolean | null | undefined;
  'bind:offsetWidth'?: number | null | undefined;
  'bind:offsetHeight'?: number | null | undefined;
  'aria-activedescendant'?: string | null | undefined;
  'aria-atomic'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-autocomplete'?: 'none' | 'list' | 'inline' | 'both' | null | undefined;
  'aria-busy'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-checked'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-colcount'?: number | null | undefined;
  'aria-colindex'?: number | null | undefined;
  'aria-colspan'?: number | null | undefined;
  'aria-controls'?: string | null | undefined;
  'aria-current'?:
    | import('svelte/elements').Booleanish
    | 'page'
    | 'step'
    | 'location'
    | 'date'
    | 'time'
    | null
    | undefined;
  'aria-describedby'?: string | null | undefined;
  'aria-details'?: string | null | undefined;
  'aria-disabled'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-dropeffect'?: 'none' | 'link' | 'copy' | 'execute' | 'move' | 'popup' | null | undefined;
  'aria-errormessage'?: string | null | undefined;
  'aria-expanded'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-flowto'?: string | null | undefined;
  'aria-grabbed'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-haspopup'?:
    | 'dialog'
    | import('svelte/elements').Booleanish
    | 'grid'
    | 'listbox'
    | 'menu'
    | 'tree'
    | null
    | undefined;
  'aria-hidden'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-invalid'?: import('svelte/elements').Booleanish | 'grammar' | 'spelling' | null | undefined;
  'aria-keyshortcuts'?: string | null | undefined;
  'aria-label'?: string | null | undefined;
  'aria-labelledby'?: string | null | undefined;
  'aria-level'?: number | null | undefined;
  'aria-live'?: 'off' | 'assertive' | 'polite' | null | undefined;
  'aria-modal'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiline'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiselectable'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-orientation'?: 'horizontal' | 'vertical' | null | undefined;
  'aria-owns'?: string | null | undefined;
  'aria-placeholder'?: string | null | undefined;
  'aria-posinset'?: number | null | undefined;
  'aria-pressed'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-readonly'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-relevant'?:
    | 'text'
    | 'additions'
    | 'additions removals'
    | 'additions text'
    | 'all'
    | 'removals'
    | 'removals additions'
    | 'removals text'
    | 'text additions'
    | 'text removals'
    | null
    | undefined;
  'aria-required'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-roledescription'?: string | null | undefined;
  'aria-rowcount'?: number | null | undefined;
  'aria-rowindex'?: number | null | undefined;
  'aria-rowspan'?: number | null | undefined;
  'aria-selected'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-setsize'?: number | null | undefined;
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other' | null | undefined;
  'aria-valuemax'?: number | null | undefined;
  'aria-valuemin'?: number | null | undefined;
  'aria-valuenow'?: number | null | undefined;
  'aria-valuetext'?: string | null | undefined;
  children?: import('svelte').Snippet<[]>;
  'on:copy'?: import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  oncopy?: import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  oncopycapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  'on:cut'?: import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  oncut?: import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  oncutcapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  'on:paste'?:
    import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  onpaste?: import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  onpastecapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLButtonElement> | null | undefined;
  'on:compositionend'?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  oncompositionend?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  oncompositionendcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  'on:compositionstart'?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  oncompositionstart?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  oncompositionstartcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  'on:compositionupdate'?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  oncompositionupdate?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  oncompositionupdatecapture?:
    import('svelte/elements').CompositionEventHandler<HTMLButtonElement> | null | undefined;
  'on:focus'?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onfocus?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onfocuscapture?:
    import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  'on:focusin'?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onfocusin?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onfocusincapture?:
    import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  'on:focusout'?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onfocusout?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onfocusoutcapture?:
    import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  'on:blur'?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onblur?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  onblurcapture?: import('svelte/elements').FocusEventHandler<HTMLButtonElement> | null | undefined;
  'on:change'?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  onchange?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  onchangecapture?:
    import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  'on:beforeinput'?:
    import('svelte/elements').EventHandler<InputEvent, HTMLButtonElement> | null | undefined;
  onbeforeinput?:
    import('svelte/elements').EventHandler<InputEvent, HTMLButtonElement> | null | undefined;
  onbeforeinputcapture?:
    import('svelte/elements').EventHandler<InputEvent, HTMLButtonElement> | null | undefined;
  'on:input'?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  oninput?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  oninputcapture?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  'on:reset'?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  onreset?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  onresetcapture?: import('svelte/elements').FormEventHandler<HTMLButtonElement> | null | undefined;
  'on:submit'?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLButtonElement> | null | undefined;
  onsubmit?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLButtonElement> | null | undefined;
  onsubmitcapture?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLButtonElement> | null | undefined;
  'on:invalid'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oninvalid?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oninvalidcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:formdata'?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLButtonElement> | null | undefined;
  onformdata?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLButtonElement> | null | undefined;
  onformdatacapture?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLButtonElement> | null | undefined;
  'on:load'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onload?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onloadcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:error'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerror?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerrorcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:beforetoggle'?:
    import('svelte/elements').ToggleEventHandler<HTMLButtonElement> | null | undefined;
  onbeforetoggle?:
    import('svelte/elements').ToggleEventHandler<HTMLButtonElement> | null | undefined;
  onbeforetogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLButtonElement> | null | undefined;
  'on:toggle'?: import('svelte/elements').ToggleEventHandler<HTMLButtonElement> | null | undefined;
  ontoggle?: import('svelte/elements').ToggleEventHandler<HTMLButtonElement> | null | undefined;
  ontogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLButtonElement> | null | undefined;
  'on:contentvisibilityautostatechange'?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLButtonElement>
    | null
    | undefined;
  oncontentvisibilityautostatechange?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLButtonElement>
    | null
    | undefined;
  oncontentvisibilityautostatechangecapture?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLButtonElement>
    | null
    | undefined;
  'on:keydown'?:
    import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  onkeydown?: import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  onkeydowncapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  'on:keypress'?:
    import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  onkeypress?: import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  onkeypresscapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  'on:keyup'?: import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  onkeyup?: import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  onkeyupcapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLButtonElement> | null | undefined;
  'on:abort'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onabort?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onabortcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:canplay'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncanplay?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncanplaycapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:canplaythrough'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncanplaythrough?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncanplaythroughcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:cuechange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncuechange?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncuechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:durationchange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  ondurationchange?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  ondurationchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:emptied'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onemptied?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onemptiedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:encrypted'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onencrypted?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onencryptedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:ended'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onended?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onendedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:loadeddata'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onloadeddata?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onloadeddatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:loadedmetadata'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onloadedmetadata?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onloadedmetadatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:loadstart'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onloadstart?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onloadstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:pause'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onpause?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onpausecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:play'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onplay?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onplaycapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:playing'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onplaying?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onplayingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:progress'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onprogress?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onprogresscapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:ratechange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onratechange?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onratechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:seeked'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onseeked?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onseekedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:seeking'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onseeking?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onseekingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:stalled'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onstalled?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onstalledcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:suspend'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onsuspend?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onsuspendcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:timeupdate'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  ontimeupdate?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  ontimeupdatecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:volumechange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onvolumechange?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onvolumechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:waiting'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onwaiting?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onwaitingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:auxclick'?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onauxclick?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onauxclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:click'?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onclick?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:contextmenu'?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  oncontextmenu?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  oncontextmenucapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:dblclick'?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  ondblclick?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  ondblclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:drag'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondrag?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragcapture?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:dragend'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragend?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragendcapture?:
    import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:dragenter'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragenter?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragentercapture?:
    import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:dragexit'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragexit?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragexitcapture?:
    import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:dragleave'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragleave?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragleavecapture?:
    import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:dragover'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragover?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragovercapture?:
    import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:dragstart'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragstart?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondragstartcapture?:
    import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:drop'?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondrop?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  ondropcapture?: import('svelte/elements').DragEventHandler<HTMLButtonElement> | null | undefined;
  'on:mousedown'?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmousedown?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmousedowncapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:mouseenter'?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseenter?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:mouseleave'?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseleave?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:mousemove'?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmousemove?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmousemovecapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:mouseout'?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseout?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseoutcapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:mouseover'?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseover?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseovercapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:mouseup'?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseup?: import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  onmouseupcapture?:
    import('svelte/elements').MouseEventHandler<HTMLButtonElement> | null | undefined;
  'on:select'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onselect?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onselectcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:selectionchange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onselectionchange?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onselectionchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:selectstart'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onselectstart?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onselectstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:touchcancel'?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchcancel?: import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchcancelcapture?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  'on:touchend'?: import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchend?: import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchendcapture?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  'on:touchmove'?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchmove?: import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchmovecapture?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  'on:touchstart'?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchstart?: import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  ontouchstartcapture?:
    import('svelte/elements').TouchEventHandler<HTMLButtonElement> | null | undefined;
  'on:gotpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  ongotpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  ongotpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointercancel'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointercancel?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointercancelcapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointerdown'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerdown?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerdowncapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointerenter'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerenter?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerentercapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointerleave'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerleave?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerleavecapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointermove'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointermove?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointermovecapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointerout'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerout?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointeroutcapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointerover'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerover?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerovercapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:pointerup'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerup?: import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onpointerupcapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:lostpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onlostpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  onlostpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLButtonElement> | null | undefined;
  'on:gamepadconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLButtonElement> | null | undefined;
  ongamepadconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLButtonElement> | null | undefined;
  'on:gamepaddisconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLButtonElement> | null | undefined;
  ongamepaddisconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLButtonElement> | null | undefined;
  'on:scroll'?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  onscroll?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  onscrollcapture?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  'on:scrollend'?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  onscrollend?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  onscrollendcapture?:
    import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  'on:resize'?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  onresize?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  onresizecapture?: import('svelte/elements').UIEventHandler<HTMLButtonElement> | null | undefined;
  'on:wheel'?: import('svelte/elements').WheelEventHandler<HTMLButtonElement> | null | undefined;
  onwheel?: import('svelte/elements').WheelEventHandler<HTMLButtonElement> | null | undefined;
  onwheelcapture?:
    import('svelte/elements').WheelEventHandler<HTMLButtonElement> | null | undefined;
  'on:animationstart'?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  onanimationstart?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  onanimationstartcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  'on:animationend'?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  onanimationend?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  onanimationendcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  'on:animationiteration'?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  onanimationiteration?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  onanimationiterationcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLButtonElement> | null | undefined;
  'on:transitionstart'?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitionstart?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitionstartcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  'on:transitionrun'?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitionrun?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitionruncapture?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  'on:transitionend'?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitionend?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitionendcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  'on:transitioncancel'?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitioncancel?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  ontransitioncancelcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLButtonElement> | null | undefined;
  'on:outrostart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onoutrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onoutrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  'on:outroend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onoutroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onoutroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  'on:introstart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onintrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onintrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  'on:introend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onintroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  onintroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLButtonElement> | null | undefined;
  'on:message'?:
    import('svelte/elements').MessageEventHandler<HTMLButtonElement> | null | undefined;
  onmessage?: import('svelte/elements').MessageEventHandler<HTMLButtonElement> | null | undefined;
  onmessagecapture?:
    import('svelte/elements').MessageEventHandler<HTMLButtonElement> | null | undefined;
  'on:messageerror'?:
    import('svelte/elements').MessageEventHandler<HTMLButtonElement> | null | undefined;
  onmessageerror?:
    import('svelte/elements').MessageEventHandler<HTMLButtonElement> | null | undefined;
  onmessageerrorcapture?:
    import('svelte/elements').MessageEventHandler<HTMLButtonElement> | null | undefined;
  'on:visibilitychange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onvisibilitychange?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onvisibilitychangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:beforematch'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onbeforematch?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onbeforematchcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:cancel'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncancel?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  oncancelcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:close'?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onclose?: import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onclosecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:fullscreenchange'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onfullscreenchange?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onfullscreenchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'on:fullscreenerror'?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onfullscreenerror?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  onfullscreenerrorcapture?:
    import('svelte/elements').EventHandler<Event, HTMLButtonElement> | null | undefined;
  'bind:contentRect'?: DOMRectReadOnly | null | undefined;
  'bind:contentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:borderBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:devicePixelContentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:clientWidth'?: number | null | undefined;
  'bind:clientHeight'?: number | null | undefined;
  xmlns?: string | null | undefined;
};

export type FlatHTMLButtonAttributesIndexSignatures = {
  [key: `data-${string}`]: any;
  [key: symbol]:
    false | import('svelte/attachments').Attachment<HTMLButtonElement> | null | undefined;
};

export type FlatHTMLAnchorAttributes = {
  download?: any;
  href?: string | null | undefined;
  hreflang?: string | null | undefined;
  media?: string | null | undefined;
  ping?: string | null | undefined;
  rel?: string | null | undefined;
  target?: import('svelte/elements').HTMLAttributeAnchorTarget | null | undefined;
  type?: string | null | undefined;
  referrerpolicy?: ReferrerPolicy | null | undefined;
  accesskey?: string | null | undefined;
  autocapitalize?: 'characters' | 'off' | 'on' | 'none' | 'sentences' | 'words' | null | undefined;
  autofocus?: boolean | null | undefined;
  class?: import('svelte/elements').ClassValue | null | undefined;
  contenteditable?:
    import('svelte/elements').Booleanish | 'inherit' | 'plaintext-only' | null | undefined;
  contextmenu?: string | null | undefined;
  dir?: 'ltr' | 'rtl' | 'auto' | null | undefined;
  draggable?: import('svelte/elements').Booleanish | null | undefined;
  elementtiming?: string | null | undefined;
  enterkeyhint?:
    'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send' | null | undefined;
  hidden?: boolean | '' | 'until-found' | null | undefined;
  id?: string | null | undefined;
  lang?: string | null | undefined;
  part?: string | null | undefined;
  placeholder?: string | null | undefined;
  slot?: string | null | undefined;
  spellcheck?: import('svelte/elements').Booleanish | null | undefined;
  style?: string | null | undefined;
  tabindex?: number | null | undefined;
  title?: string | null | undefined;
  translate?: '' | 'yes' | 'no' | null | undefined;
  inert?: boolean | null | undefined;
  popover?: '' | 'auto' | 'manual' | 'hint' | null | undefined;
  writingsuggestions?: import('svelte/elements').Booleanish | null | undefined;
  radiogroup?: string | null | undefined;
  role?: import('svelte/elements').AriaRole | null | undefined;
  about?: string | null | undefined;
  datatype?: string | null | undefined;
  inlist?: any;
  prefix?: string | null | undefined;
  property?: string | null | undefined;
  resource?: string | null | undefined;
  typeof?: string | null | undefined;
  vocab?: string | null | undefined;
  autosave?: string | null | undefined;
  color?: string | null | undefined;
  itemprop?: string | null | undefined;
  itemscope?: boolean | null | undefined;
  itemtype?: string | null | undefined;
  itemid?: string | null | undefined;
  itemref?: string | null | undefined;
  results?: number | null | undefined;
  security?: string | null | undefined;
  unselectable?: 'off' | 'on' | null | undefined;
  inputmode?:
    'none' | 'search' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | null | undefined;
  is?: string | null | undefined;
  'bind:innerHTML'?: string | null | undefined;
  'bind:textContent'?: string | null | undefined;
  'bind:innerText'?: string | null | undefined;
  'bind:focused'?: boolean | null | undefined;
  'bind:offsetWidth'?: number | null | undefined;
  'bind:offsetHeight'?: number | null | undefined;
  'aria-activedescendant'?: string | null | undefined;
  'aria-atomic'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-autocomplete'?: 'none' | 'list' | 'inline' | 'both' | null | undefined;
  'aria-busy'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-checked'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-colcount'?: number | null | undefined;
  'aria-colindex'?: number | null | undefined;
  'aria-colspan'?: number | null | undefined;
  'aria-controls'?: string | null | undefined;
  'aria-current'?:
    | import('svelte/elements').Booleanish
    | 'page'
    | 'step'
    | 'location'
    | 'date'
    | 'time'
    | null
    | undefined;
  'aria-describedby'?: string | null | undefined;
  'aria-details'?: string | null | undefined;
  'aria-disabled'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-dropeffect'?: 'none' | 'link' | 'copy' | 'execute' | 'move' | 'popup' | null | undefined;
  'aria-errormessage'?: string | null | undefined;
  'aria-expanded'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-flowto'?: string | null | undefined;
  'aria-grabbed'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-haspopup'?:
    | 'dialog'
    | import('svelte/elements').Booleanish
    | 'grid'
    | 'listbox'
    | 'menu'
    | 'tree'
    | null
    | undefined;
  'aria-hidden'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-invalid'?: import('svelte/elements').Booleanish | 'grammar' | 'spelling' | null | undefined;
  'aria-keyshortcuts'?: string | null | undefined;
  'aria-label'?: string | null | undefined;
  'aria-labelledby'?: string | null | undefined;
  'aria-level'?: number | null | undefined;
  'aria-live'?: 'off' | 'assertive' | 'polite' | null | undefined;
  'aria-modal'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiline'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiselectable'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-orientation'?: 'horizontal' | 'vertical' | null | undefined;
  'aria-owns'?: string | null | undefined;
  'aria-placeholder'?: string | null | undefined;
  'aria-posinset'?: number | null | undefined;
  'aria-pressed'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-readonly'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-relevant'?:
    | 'text'
    | 'additions'
    | 'additions removals'
    | 'additions text'
    | 'all'
    | 'removals'
    | 'removals additions'
    | 'removals text'
    | 'text additions'
    | 'text removals'
    | null
    | undefined;
  'aria-required'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-roledescription'?: string | null | undefined;
  'aria-rowcount'?: number | null | undefined;
  'aria-rowindex'?: number | null | undefined;
  'aria-rowspan'?: number | null | undefined;
  'aria-selected'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-setsize'?: number | null | undefined;
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other' | null | undefined;
  'aria-valuemax'?: number | null | undefined;
  'aria-valuemin'?: number | null | undefined;
  'aria-valuenow'?: number | null | undefined;
  'aria-valuetext'?: string | null | undefined;
  children?: import('svelte').Snippet<[]>;
  'on:copy'?: import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  oncopy?: import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  oncopycapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  'on:cut'?: import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  oncut?: import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  oncutcapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  'on:paste'?:
    import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  onpaste?: import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  onpastecapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLAnchorElement> | null | undefined;
  'on:compositionend'?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  oncompositionend?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  oncompositionendcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:compositionstart'?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  oncompositionstart?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  oncompositionstartcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:compositionupdate'?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  oncompositionupdate?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  oncompositionupdatecapture?:
    import('svelte/elements').CompositionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:focus'?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onfocus?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onfocuscapture?:
    import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  'on:focusin'?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onfocusin?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onfocusincapture?:
    import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  'on:focusout'?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onfocusout?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onfocusoutcapture?:
    import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  'on:blur'?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onblur?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  onblurcapture?: import('svelte/elements').FocusEventHandler<HTMLAnchorElement> | null | undefined;
  'on:change'?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  onchange?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  onchangecapture?:
    import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  'on:beforeinput'?:
    import('svelte/elements').EventHandler<InputEvent, HTMLAnchorElement> | null | undefined;
  onbeforeinput?:
    import('svelte/elements').EventHandler<InputEvent, HTMLAnchorElement> | null | undefined;
  onbeforeinputcapture?:
    import('svelte/elements').EventHandler<InputEvent, HTMLAnchorElement> | null | undefined;
  'on:input'?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  oninput?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  oninputcapture?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  'on:reset'?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  onreset?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  onresetcapture?: import('svelte/elements').FormEventHandler<HTMLAnchorElement> | null | undefined;
  'on:submit'?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLAnchorElement> | null | undefined;
  onsubmit?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLAnchorElement> | null | undefined;
  onsubmitcapture?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLAnchorElement> | null | undefined;
  'on:invalid'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oninvalid?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oninvalidcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:formdata'?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLAnchorElement> | null | undefined;
  onformdata?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLAnchorElement> | null | undefined;
  onformdatacapture?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLAnchorElement> | null | undefined;
  'on:load'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onload?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onloadcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:error'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerror?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerrorcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:beforetoggle'?:
    import('svelte/elements').ToggleEventHandler<HTMLAnchorElement> | null | undefined;
  onbeforetoggle?:
    import('svelte/elements').ToggleEventHandler<HTMLAnchorElement> | null | undefined;
  onbeforetogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLAnchorElement> | null | undefined;
  'on:toggle'?: import('svelte/elements').ToggleEventHandler<HTMLAnchorElement> | null | undefined;
  ontoggle?: import('svelte/elements').ToggleEventHandler<HTMLAnchorElement> | null | undefined;
  ontogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLAnchorElement> | null | undefined;
  'on:contentvisibilityautostatechange'?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLAnchorElement>
    | null
    | undefined;
  oncontentvisibilityautostatechange?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLAnchorElement>
    | null
    | undefined;
  oncontentvisibilityautostatechangecapture?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLAnchorElement>
    | null
    | undefined;
  'on:keydown'?:
    import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  onkeydown?: import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  onkeydowncapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  'on:keypress'?:
    import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  onkeypress?: import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  onkeypresscapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  'on:keyup'?: import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  onkeyup?: import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  onkeyupcapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLAnchorElement> | null | undefined;
  'on:abort'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onabort?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onabortcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:canplay'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncanplay?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncanplaycapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:canplaythrough'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncanplaythrough?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncanplaythroughcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:cuechange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncuechange?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncuechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:durationchange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  ondurationchange?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  ondurationchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:emptied'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onemptied?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onemptiedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:encrypted'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onencrypted?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onencryptedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:ended'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onended?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onendedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:loadeddata'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onloadeddata?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onloadeddatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:loadedmetadata'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onloadedmetadata?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onloadedmetadatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:loadstart'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onloadstart?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onloadstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:pause'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onpause?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onpausecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:play'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onplay?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onplaycapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:playing'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onplaying?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onplayingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:progress'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onprogress?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onprogresscapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:ratechange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onratechange?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onratechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:seeked'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onseeked?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onseekedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:seeking'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onseeking?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onseekingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:stalled'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onstalled?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onstalledcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:suspend'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onsuspend?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onsuspendcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:timeupdate'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  ontimeupdate?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  ontimeupdatecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:volumechange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onvolumechange?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onvolumechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:waiting'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onwaiting?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onwaitingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:auxclick'?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onauxclick?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onauxclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:click'?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onclick?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:contextmenu'?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  oncontextmenu?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  oncontextmenucapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dblclick'?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  ondblclick?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  ondblclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:drag'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondrag?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragcapture?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dragend'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragend?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragendcapture?:
    import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dragenter'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragenter?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragentercapture?:
    import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dragexit'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragexit?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragexitcapture?:
    import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dragleave'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragleave?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragleavecapture?:
    import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dragover'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragover?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragovercapture?:
    import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:dragstart'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragstart?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondragstartcapture?:
    import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:drop'?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondrop?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  ondropcapture?: import('svelte/elements').DragEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mousedown'?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmousedown?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmousedowncapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mouseenter'?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseenter?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mouseleave'?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseleave?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mousemove'?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmousemove?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmousemovecapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mouseout'?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseout?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseoutcapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mouseover'?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseover?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseovercapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:mouseup'?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseup?: import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  onmouseupcapture?:
    import('svelte/elements').MouseEventHandler<HTMLAnchorElement> | null | undefined;
  'on:select'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onselect?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onselectcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:selectionchange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onselectionchange?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onselectionchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:selectstart'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onselectstart?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onselectstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:touchcancel'?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchcancel?: import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchcancelcapture?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  'on:touchend'?: import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchend?: import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchendcapture?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  'on:touchmove'?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchmove?: import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchmovecapture?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  'on:touchstart'?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchstart?: import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  ontouchstartcapture?:
    import('svelte/elements').TouchEventHandler<HTMLAnchorElement> | null | undefined;
  'on:gotpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  ongotpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  ongotpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointercancel'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointercancel?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointercancelcapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointerdown'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerdown?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerdowncapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointerenter'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerenter?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerentercapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointerleave'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerleave?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerleavecapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointermove'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointermove?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointermovecapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointerout'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerout?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointeroutcapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointerover'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerover?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerovercapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:pointerup'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerup?: import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onpointerupcapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:lostpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onlostpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  onlostpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLAnchorElement> | null | undefined;
  'on:gamepadconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLAnchorElement> | null | undefined;
  ongamepadconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLAnchorElement> | null | undefined;
  'on:gamepaddisconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLAnchorElement> | null | undefined;
  ongamepaddisconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLAnchorElement> | null | undefined;
  'on:scroll'?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  onscroll?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  onscrollcapture?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  'on:scrollend'?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  onscrollend?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  onscrollendcapture?:
    import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  'on:resize'?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  onresize?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  onresizecapture?: import('svelte/elements').UIEventHandler<HTMLAnchorElement> | null | undefined;
  'on:wheel'?: import('svelte/elements').WheelEventHandler<HTMLAnchorElement> | null | undefined;
  onwheel?: import('svelte/elements').WheelEventHandler<HTMLAnchorElement> | null | undefined;
  onwheelcapture?:
    import('svelte/elements').WheelEventHandler<HTMLAnchorElement> | null | undefined;
  'on:animationstart'?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  onanimationstart?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  onanimationstartcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  'on:animationend'?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  onanimationend?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  onanimationendcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  'on:animationiteration'?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  onanimationiteration?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  onanimationiterationcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLAnchorElement> | null | undefined;
  'on:transitionstart'?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitionstart?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitionstartcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:transitionrun'?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitionrun?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitionruncapture?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:transitionend'?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitionend?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitionendcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:transitioncancel'?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitioncancel?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  ontransitioncancelcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLAnchorElement> | null | undefined;
  'on:outrostart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onoutrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onoutrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  'on:outroend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onoutroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onoutroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  'on:introstart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onintrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onintrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  'on:introend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onintroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  onintroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLAnchorElement> | null | undefined;
  'on:message'?:
    import('svelte/elements').MessageEventHandler<HTMLAnchorElement> | null | undefined;
  onmessage?: import('svelte/elements').MessageEventHandler<HTMLAnchorElement> | null | undefined;
  onmessagecapture?:
    import('svelte/elements').MessageEventHandler<HTMLAnchorElement> | null | undefined;
  'on:messageerror'?:
    import('svelte/elements').MessageEventHandler<HTMLAnchorElement> | null | undefined;
  onmessageerror?:
    import('svelte/elements').MessageEventHandler<HTMLAnchorElement> | null | undefined;
  onmessageerrorcapture?:
    import('svelte/elements').MessageEventHandler<HTMLAnchorElement> | null | undefined;
  'on:visibilitychange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onvisibilitychange?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onvisibilitychangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:beforematch'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onbeforematch?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onbeforematchcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:cancel'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncancel?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  oncancelcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:close'?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onclose?: import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onclosecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:fullscreenchange'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onfullscreenchange?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onfullscreenchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'on:fullscreenerror'?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onfullscreenerror?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  onfullscreenerrorcapture?:
    import('svelte/elements').EventHandler<Event, HTMLAnchorElement> | null | undefined;
  'bind:contentRect'?: DOMRectReadOnly | null | undefined;
  'bind:contentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:borderBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:devicePixelContentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:clientWidth'?: number | null | undefined;
  'bind:clientHeight'?: number | null | undefined;
  xmlns?: string | null | undefined;
};

export type FlatHTMLAnchorAttributesIndexSignatures = {
  [key: `data-${string}`]: any;
  [key: symbol]:
    false | import('svelte/attachments').Attachment<HTMLAnchorElement> | null | undefined;
};

export type FlatHTMLAttributesElement = {
  accesskey?: string | null | undefined;
  autocapitalize?: 'characters' | 'off' | 'on' | 'none' | 'sentences' | 'words' | null | undefined;
  autofocus?: boolean | null | undefined;
  class?: import('svelte/elements').ClassValue | null | undefined;
  contenteditable?:
    import('svelte/elements').Booleanish | 'inherit' | 'plaintext-only' | null | undefined;
  contextmenu?: string | null | undefined;
  dir?: 'ltr' | 'rtl' | 'auto' | null | undefined;
  draggable?: import('svelte/elements').Booleanish | null | undefined;
  elementtiming?: string | null | undefined;
  enterkeyhint?:
    'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send' | null | undefined;
  hidden?: boolean | '' | 'until-found' | null | undefined;
  id?: string | null | undefined;
  lang?: string | null | undefined;
  part?: string | null | undefined;
  placeholder?: string | null | undefined;
  slot?: string | null | undefined;
  spellcheck?: import('svelte/elements').Booleanish | null | undefined;
  style?: string | null | undefined;
  tabindex?: number | null | undefined;
  title?: string | null | undefined;
  translate?: '' | 'yes' | 'no' | null | undefined;
  inert?: boolean | null | undefined;
  popover?: '' | 'auto' | 'manual' | 'hint' | null | undefined;
  writingsuggestions?: import('svelte/elements').Booleanish | null | undefined;
  radiogroup?: string | null | undefined;
  role?: import('svelte/elements').AriaRole | null | undefined;
  about?: string | null | undefined;
  datatype?: string | null | undefined;
  inlist?: any;
  prefix?: string | null | undefined;
  property?: string | null | undefined;
  resource?: string | null | undefined;
  typeof?: string | null | undefined;
  vocab?: string | null | undefined;
  autosave?: string | null | undefined;
  color?: string | null | undefined;
  itemprop?: string | null | undefined;
  itemscope?: boolean | null | undefined;
  itemtype?: string | null | undefined;
  itemid?: string | null | undefined;
  itemref?: string | null | undefined;
  results?: number | null | undefined;
  security?: string | null | undefined;
  unselectable?: 'off' | 'on' | null | undefined;
  inputmode?:
    'none' | 'search' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | null | undefined;
  is?: string | null | undefined;
  'bind:innerHTML'?: string | null | undefined;
  'bind:textContent'?: string | null | undefined;
  'bind:innerText'?: string | null | undefined;
  'bind:focused'?: boolean | null | undefined;
  'bind:offsetWidth'?: number | null | undefined;
  'bind:offsetHeight'?: number | null | undefined;
  'aria-activedescendant'?: string | null | undefined;
  'aria-atomic'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-autocomplete'?: 'none' | 'list' | 'inline' | 'both' | null | undefined;
  'aria-busy'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-checked'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-colcount'?: number | null | undefined;
  'aria-colindex'?: number | null | undefined;
  'aria-colspan'?: number | null | undefined;
  'aria-controls'?: string | null | undefined;
  'aria-current'?:
    | import('svelte/elements').Booleanish
    | 'page'
    | 'step'
    | 'location'
    | 'date'
    | 'time'
    | null
    | undefined;
  'aria-describedby'?: string | null | undefined;
  'aria-details'?: string | null | undefined;
  'aria-disabled'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-dropeffect'?: 'none' | 'link' | 'copy' | 'execute' | 'move' | 'popup' | null | undefined;
  'aria-errormessage'?: string | null | undefined;
  'aria-expanded'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-flowto'?: string | null | undefined;
  'aria-grabbed'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-haspopup'?:
    | 'dialog'
    | import('svelte/elements').Booleanish
    | 'grid'
    | 'listbox'
    | 'menu'
    | 'tree'
    | null
    | undefined;
  'aria-hidden'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-invalid'?: import('svelte/elements').Booleanish | 'grammar' | 'spelling' | null | undefined;
  'aria-keyshortcuts'?: string | null | undefined;
  'aria-label'?: string | null | undefined;
  'aria-labelledby'?: string | null | undefined;
  'aria-level'?: number | null | undefined;
  'aria-live'?: 'off' | 'assertive' | 'polite' | null | undefined;
  'aria-modal'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiline'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiselectable'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-orientation'?: 'horizontal' | 'vertical' | null | undefined;
  'aria-owns'?: string | null | undefined;
  'aria-placeholder'?: string | null | undefined;
  'aria-posinset'?: number | null | undefined;
  'aria-pressed'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-readonly'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-relevant'?:
    | 'text'
    | 'additions'
    | 'additions removals'
    | 'additions text'
    | 'all'
    | 'removals'
    | 'removals additions'
    | 'removals text'
    | 'text additions'
    | 'text removals'
    | null
    | undefined;
  'aria-required'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-roledescription'?: string | null | undefined;
  'aria-rowcount'?: number | null | undefined;
  'aria-rowindex'?: number | null | undefined;
  'aria-rowspan'?: number | null | undefined;
  'aria-selected'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-setsize'?: number | null | undefined;
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other' | null | undefined;
  'aria-valuemax'?: number | null | undefined;
  'aria-valuemin'?: number | null | undefined;
  'aria-valuenow'?: number | null | undefined;
  'aria-valuetext'?: string | null | undefined;
  children?: import('svelte').Snippet<[]>;
  'on:copy'?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  oncopy?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  oncopycapture?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  'on:cut'?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  oncut?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  oncutcapture?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  'on:paste'?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  onpaste?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  onpastecapture?: import('svelte/elements').ClipboardEventHandler<HTMLElement> | null | undefined;
  'on:compositionend'?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  oncompositionend?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  oncompositionendcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  'on:compositionstart'?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  oncompositionstart?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  oncompositionstartcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  'on:compositionupdate'?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  oncompositionupdate?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  oncompositionupdatecapture?:
    import('svelte/elements').CompositionEventHandler<HTMLElement> | null | undefined;
  'on:focus'?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onfocus?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onfocuscapture?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  'on:focusin'?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onfocusin?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onfocusincapture?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  'on:focusout'?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onfocusout?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onfocusoutcapture?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  'on:blur'?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onblur?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  onblurcapture?: import('svelte/elements').FocusEventHandler<HTMLElement> | null | undefined;
  'on:change'?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  onchange?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  onchangecapture?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  'on:beforeinput'?:
    import('svelte/elements').EventHandler<InputEvent, HTMLElement> | null | undefined;
  onbeforeinput?:
    import('svelte/elements').EventHandler<InputEvent, HTMLElement> | null | undefined;
  onbeforeinputcapture?:
    import('svelte/elements').EventHandler<InputEvent, HTMLElement> | null | undefined;
  'on:input'?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  oninput?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  oninputcapture?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  'on:reset'?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  onreset?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  onresetcapture?: import('svelte/elements').FormEventHandler<HTMLElement> | null | undefined;
  'on:submit'?: import('svelte/elements').EventHandler<SubmitEvent, HTMLElement> | null | undefined;
  onsubmit?: import('svelte/elements').EventHandler<SubmitEvent, HTMLElement> | null | undefined;
  onsubmitcapture?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLElement> | null | undefined;
  'on:invalid'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oninvalid?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oninvalidcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:formdata'?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLElement> | null | undefined;
  onformdata?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLElement> | null | undefined;
  onformdatacapture?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLElement> | null | undefined;
  'on:load'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onload?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onloadcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:error'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerror?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerrorcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:beforetoggle'?: import('svelte/elements').ToggleEventHandler<HTMLElement> | null | undefined;
  onbeforetoggle?: import('svelte/elements').ToggleEventHandler<HTMLElement> | null | undefined;
  onbeforetogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLElement> | null | undefined;
  'on:toggle'?: import('svelte/elements').ToggleEventHandler<HTMLElement> | null | undefined;
  ontoggle?: import('svelte/elements').ToggleEventHandler<HTMLElement> | null | undefined;
  ontogglecapture?: import('svelte/elements').ToggleEventHandler<HTMLElement> | null | undefined;
  'on:contentvisibilityautostatechange'?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLElement>
    | null
    | undefined;
  oncontentvisibilityautostatechange?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLElement>
    | null
    | undefined;
  oncontentvisibilityautostatechangecapture?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLElement>
    | null
    | undefined;
  'on:keydown'?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  onkeydown?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  onkeydowncapture?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  'on:keypress'?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  onkeypress?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  onkeypresscapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  'on:keyup'?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  onkeyup?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  onkeyupcapture?: import('svelte/elements').KeyboardEventHandler<HTMLElement> | null | undefined;
  'on:abort'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onabort?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onabortcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:canplay'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncanplay?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncanplaycapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:canplaythrough'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncanplaythrough?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncanplaythroughcapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:cuechange'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncuechange?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncuechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:durationchange'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  ondurationchange?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  ondurationchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:emptied'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onemptied?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onemptiedcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:encrypted'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onencrypted?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onencryptedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:ended'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onended?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onendedcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:loadeddata'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onloadeddata?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onloadeddatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:loadedmetadata'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onloadedmetadata?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onloadedmetadatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:loadstart'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onloadstart?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onloadstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:pause'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onpause?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onpausecapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:play'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onplay?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onplaycapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:playing'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onplaying?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onplayingcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:progress'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onprogress?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onprogresscapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:ratechange'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onratechange?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onratechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:seeked'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onseeked?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onseekedcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:seeking'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onseeking?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onseekingcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:stalled'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onstalled?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onstalledcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:suspend'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onsuspend?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onsuspendcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:timeupdate'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  ontimeupdate?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  ontimeupdatecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:volumechange'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onvolumechange?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onvolumechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:waiting'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onwaiting?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onwaitingcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:auxclick'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onauxclick?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onauxclickcapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:click'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onclick?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onclickcapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:contextmenu'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  oncontextmenu?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  oncontextmenucapture?:
    import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:dblclick'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  ondblclick?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  ondblclickcapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:drag'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondrag?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragcapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:dragend'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragend?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragendcapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:dragenter'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragenter?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragentercapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:dragexit'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragexit?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragexitcapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:dragleave'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragleave?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragleavecapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:dragover'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragover?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragovercapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:dragstart'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragstart?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondragstartcapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:drop'?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondrop?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  ondropcapture?: import('svelte/elements').DragEventHandler<HTMLElement> | null | undefined;
  'on:mousedown'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmousedown?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmousedowncapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:mouseenter'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseenter?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:mouseleave'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseleave?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:mousemove'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmousemove?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmousemovecapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:mouseout'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseout?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseoutcapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:mouseover'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseover?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseovercapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:mouseup'?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseup?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  onmouseupcapture?: import('svelte/elements').MouseEventHandler<HTMLElement> | null | undefined;
  'on:select'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onselect?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onselectcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:selectionchange'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onselectionchange?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onselectionchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:selectstart'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onselectstart?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onselectstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:touchcancel'?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchcancel?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchcancelcapture?:
    import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  'on:touchend'?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchend?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchendcapture?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  'on:touchmove'?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchmove?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchmovecapture?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  'on:touchstart'?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchstart?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  ontouchstartcapture?: import('svelte/elements').TouchEventHandler<HTMLElement> | null | undefined;
  'on:gotpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  ongotpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  ongotpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointercancel'?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointercancel?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointercancelcapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointerdown'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerdown?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerdowncapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointerenter'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerenter?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerentercapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointerleave'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerleave?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerleavecapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointermove'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointermove?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointermovecapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointerout'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerout?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointeroutcapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointerover'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerover?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerovercapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:pointerup'?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerup?: import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onpointerupcapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:lostpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onlostpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  onlostpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLElement> | null | undefined;
  'on:gamepadconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLElement> | null | undefined;
  ongamepadconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLElement> | null | undefined;
  'on:gamepaddisconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLElement> | null | undefined;
  ongamepaddisconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLElement> | null | undefined;
  'on:scroll'?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  onscroll?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  onscrollcapture?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  'on:scrollend'?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  onscrollend?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  onscrollendcapture?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  'on:resize'?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  onresize?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  onresizecapture?: import('svelte/elements').UIEventHandler<HTMLElement> | null | undefined;
  'on:wheel'?: import('svelte/elements').WheelEventHandler<HTMLElement> | null | undefined;
  onwheel?: import('svelte/elements').WheelEventHandler<HTMLElement> | null | undefined;
  onwheelcapture?: import('svelte/elements').WheelEventHandler<HTMLElement> | null | undefined;
  'on:animationstart'?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  onanimationstart?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  onanimationstartcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  'on:animationend'?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  onanimationend?: import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  onanimationendcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  'on:animationiteration'?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  onanimationiteration?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  onanimationiterationcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLElement> | null | undefined;
  'on:transitionstart'?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitionstart?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitionstartcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  'on:transitionrun'?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitionrun?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitionruncapture?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  'on:transitionend'?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitionend?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitionendcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  'on:transitioncancel'?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitioncancel?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  ontransitioncancelcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLElement> | null | undefined;
  'on:outrostart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onoutrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onoutrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  'on:outroend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onoutroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onoutroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  'on:introstart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onintrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onintrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  'on:introend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onintroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  onintroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLElement> | null | undefined;
  'on:message'?: import('svelte/elements').MessageEventHandler<HTMLElement> | null | undefined;
  onmessage?: import('svelte/elements').MessageEventHandler<HTMLElement> | null | undefined;
  onmessagecapture?: import('svelte/elements').MessageEventHandler<HTMLElement> | null | undefined;
  'on:messageerror'?: import('svelte/elements').MessageEventHandler<HTMLElement> | null | undefined;
  onmessageerror?: import('svelte/elements').MessageEventHandler<HTMLElement> | null | undefined;
  onmessageerrorcapture?:
    import('svelte/elements').MessageEventHandler<HTMLElement> | null | undefined;
  'on:visibilitychange'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onvisibilitychange?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onvisibilitychangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:beforematch'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onbeforematch?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onbeforematchcapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:cancel'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncancel?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  oncancelcapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:close'?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onclose?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onclosecapture?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:fullscreenchange'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onfullscreenchange?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onfullscreenchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'on:fullscreenerror'?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onfullscreenerror?: import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  onfullscreenerrorcapture?:
    import('svelte/elements').EventHandler<Event, HTMLElement> | null | undefined;
  'bind:contentRect'?: DOMRectReadOnly | null | undefined;
  'bind:contentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:borderBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:devicePixelContentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:clientWidth'?: number | null | undefined;
  'bind:clientHeight'?: number | null | undefined;
  xmlns?: string | null | undefined;
};

export type FlatHTMLAttributesElementIndexSignatures = {
  [key: `data-${string}`]: any;
  [key: symbol]: false | import('svelte/attachments').Attachment<HTMLElement> | null | undefined;
};

export type FlatHTMLAttributesDivElement = {
  accesskey?: string | null | undefined;
  autocapitalize?: 'characters' | 'off' | 'on' | 'none' | 'sentences' | 'words' | null | undefined;
  autofocus?: boolean | null | undefined;
  class?: import('svelte/elements').ClassValue | null | undefined;
  contenteditable?:
    import('svelte/elements').Booleanish | 'inherit' | 'plaintext-only' | null | undefined;
  contextmenu?: string | null | undefined;
  dir?: 'ltr' | 'rtl' | 'auto' | null | undefined;
  draggable?: import('svelte/elements').Booleanish | null | undefined;
  elementtiming?: string | null | undefined;
  enterkeyhint?:
    'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send' | null | undefined;
  hidden?: boolean | '' | 'until-found' | null | undefined;
  id?: string | null | undefined;
  lang?: string | null | undefined;
  part?: string | null | undefined;
  placeholder?: string | null | undefined;
  slot?: string | null | undefined;
  spellcheck?: import('svelte/elements').Booleanish | null | undefined;
  style?: string | null | undefined;
  tabindex?: number | null | undefined;
  title?: string | null | undefined;
  translate?: '' | 'yes' | 'no' | null | undefined;
  inert?: boolean | null | undefined;
  popover?: '' | 'auto' | 'manual' | 'hint' | null | undefined;
  writingsuggestions?: import('svelte/elements').Booleanish | null | undefined;
  radiogroup?: string | null | undefined;
  role?: import('svelte/elements').AriaRole | null | undefined;
  about?: string | null | undefined;
  datatype?: string | null | undefined;
  inlist?: any;
  prefix?: string | null | undefined;
  property?: string | null | undefined;
  resource?: string | null | undefined;
  typeof?: string | null | undefined;
  vocab?: string | null | undefined;
  autosave?: string | null | undefined;
  color?: string | null | undefined;
  itemprop?: string | null | undefined;
  itemscope?: boolean | null | undefined;
  itemtype?: string | null | undefined;
  itemid?: string | null | undefined;
  itemref?: string | null | undefined;
  results?: number | null | undefined;
  security?: string | null | undefined;
  unselectable?: 'off' | 'on' | null | undefined;
  inputmode?:
    'none' | 'search' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | null | undefined;
  is?: string | null | undefined;
  'bind:innerHTML'?: string | null | undefined;
  'bind:textContent'?: string | null | undefined;
  'bind:innerText'?: string | null | undefined;
  'bind:focused'?: boolean | null | undefined;
  'bind:offsetWidth'?: number | null | undefined;
  'bind:offsetHeight'?: number | null | undefined;
  'aria-activedescendant'?: string | null | undefined;
  'aria-atomic'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-autocomplete'?: 'none' | 'list' | 'inline' | 'both' | null | undefined;
  'aria-busy'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-checked'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-colcount'?: number | null | undefined;
  'aria-colindex'?: number | null | undefined;
  'aria-colspan'?: number | null | undefined;
  'aria-controls'?: string | null | undefined;
  'aria-current'?:
    | import('svelte/elements').Booleanish
    | 'page'
    | 'step'
    | 'location'
    | 'date'
    | 'time'
    | null
    | undefined;
  'aria-describedby'?: string | null | undefined;
  'aria-details'?: string | null | undefined;
  'aria-disabled'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-dropeffect'?: 'none' | 'link' | 'copy' | 'execute' | 'move' | 'popup' | null | undefined;
  'aria-errormessage'?: string | null | undefined;
  'aria-expanded'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-flowto'?: string | null | undefined;
  'aria-grabbed'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-haspopup'?:
    | 'dialog'
    | import('svelte/elements').Booleanish
    | 'grid'
    | 'listbox'
    | 'menu'
    | 'tree'
    | null
    | undefined;
  'aria-hidden'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-invalid'?: import('svelte/elements').Booleanish | 'grammar' | 'spelling' | null | undefined;
  'aria-keyshortcuts'?: string | null | undefined;
  'aria-label'?: string | null | undefined;
  'aria-labelledby'?: string | null | undefined;
  'aria-level'?: number | null | undefined;
  'aria-live'?: 'off' | 'assertive' | 'polite' | null | undefined;
  'aria-modal'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiline'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiselectable'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-orientation'?: 'horizontal' | 'vertical' | null | undefined;
  'aria-owns'?: string | null | undefined;
  'aria-placeholder'?: string | null | undefined;
  'aria-posinset'?: number | null | undefined;
  'aria-pressed'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-readonly'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-relevant'?:
    | 'text'
    | 'additions'
    | 'additions removals'
    | 'additions text'
    | 'all'
    | 'removals'
    | 'removals additions'
    | 'removals text'
    | 'text additions'
    | 'text removals'
    | null
    | undefined;
  'aria-required'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-roledescription'?: string | null | undefined;
  'aria-rowcount'?: number | null | undefined;
  'aria-rowindex'?: number | null | undefined;
  'aria-rowspan'?: number | null | undefined;
  'aria-selected'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-setsize'?: number | null | undefined;
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other' | null | undefined;
  'aria-valuemax'?: number | null | undefined;
  'aria-valuemin'?: number | null | undefined;
  'aria-valuenow'?: number | null | undefined;
  'aria-valuetext'?: string | null | undefined;
  children?: import('svelte').Snippet<[]>;
  'on:copy'?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  oncopy?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  oncopycapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  'on:cut'?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  oncut?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  oncutcapture?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  'on:paste'?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  onpaste?: import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  onpastecapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLDivElement> | null | undefined;
  'on:compositionend'?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  oncompositionend?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  oncompositionendcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  'on:compositionstart'?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  oncompositionstart?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  oncompositionstartcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  'on:compositionupdate'?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  oncompositionupdate?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  oncompositionupdatecapture?:
    import('svelte/elements').CompositionEventHandler<HTMLDivElement> | null | undefined;
  'on:focus'?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onfocus?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onfocuscapture?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  'on:focusin'?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onfocusin?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onfocusincapture?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  'on:focusout'?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onfocusout?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onfocusoutcapture?:
    import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  'on:blur'?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onblur?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  onblurcapture?: import('svelte/elements').FocusEventHandler<HTMLDivElement> | null | undefined;
  'on:change'?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  onchange?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  onchangecapture?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  'on:beforeinput'?:
    import('svelte/elements').EventHandler<InputEvent, HTMLDivElement> | null | undefined;
  onbeforeinput?:
    import('svelte/elements').EventHandler<InputEvent, HTMLDivElement> | null | undefined;
  onbeforeinputcapture?:
    import('svelte/elements').EventHandler<InputEvent, HTMLDivElement> | null | undefined;
  'on:input'?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  oninput?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  oninputcapture?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  'on:reset'?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  onreset?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  onresetcapture?: import('svelte/elements').FormEventHandler<HTMLDivElement> | null | undefined;
  'on:submit'?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLDivElement> | null | undefined;
  onsubmit?: import('svelte/elements').EventHandler<SubmitEvent, HTMLDivElement> | null | undefined;
  onsubmitcapture?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLDivElement> | null | undefined;
  'on:invalid'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oninvalid?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oninvalidcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:formdata'?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLDivElement> | null | undefined;
  onformdata?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLDivElement> | null | undefined;
  onformdatacapture?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLDivElement> | null | undefined;
  'on:load'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onload?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onloadcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:error'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerror?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerrorcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:beforetoggle'?:
    import('svelte/elements').ToggleEventHandler<HTMLDivElement> | null | undefined;
  onbeforetoggle?: import('svelte/elements').ToggleEventHandler<HTMLDivElement> | null | undefined;
  onbeforetogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLDivElement> | null | undefined;
  'on:toggle'?: import('svelte/elements').ToggleEventHandler<HTMLDivElement> | null | undefined;
  ontoggle?: import('svelte/elements').ToggleEventHandler<HTMLDivElement> | null | undefined;
  ontogglecapture?: import('svelte/elements').ToggleEventHandler<HTMLDivElement> | null | undefined;
  'on:contentvisibilityautostatechange'?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLDivElement>
    | null
    | undefined;
  oncontentvisibilityautostatechange?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLDivElement>
    | null
    | undefined;
  oncontentvisibilityautostatechangecapture?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLDivElement>
    | null
    | undefined;
  'on:keydown'?: import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  onkeydown?: import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  onkeydowncapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  'on:keypress'?: import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  onkeypress?: import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  onkeypresscapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  'on:keyup'?: import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  onkeyup?: import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  onkeyupcapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLDivElement> | null | undefined;
  'on:abort'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onabort?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onabortcapture?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:canplay'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncanplay?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncanplaycapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:canplaythrough'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncanplaythrough?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncanplaythroughcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:cuechange'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncuechange?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncuechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:durationchange'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  ondurationchange?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  ondurationchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:emptied'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onemptied?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onemptiedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:encrypted'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onencrypted?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onencryptedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:ended'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onended?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onendedcapture?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:loadeddata'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onloadeddata?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onloadeddatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:loadedmetadata'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onloadedmetadata?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onloadedmetadatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:loadstart'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onloadstart?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onloadstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:pause'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onpause?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onpausecapture?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:play'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onplay?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onplaycapture?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:playing'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onplaying?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onplayingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:progress'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onprogress?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onprogresscapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:ratechange'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onratechange?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onratechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:seeked'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onseeked?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onseekedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:seeking'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onseeking?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onseekingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:stalled'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onstalled?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onstalledcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:suspend'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onsuspend?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onsuspendcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:timeupdate'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  ontimeupdate?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  ontimeupdatecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:volumechange'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onvolumechange?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onvolumechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:waiting'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onwaiting?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onwaitingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:auxclick'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onauxclick?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onauxclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:click'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onclick?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onclickcapture?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:contextmenu'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  oncontextmenu?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  oncontextmenucapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:dblclick'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  ondblclick?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  ondblclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:drag'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondrag?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragcapture?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:dragend'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragend?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragendcapture?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:dragenter'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragenter?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragentercapture?:
    import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:dragexit'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragexit?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragexitcapture?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:dragleave'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragleave?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragleavecapture?:
    import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:dragover'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragover?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragovercapture?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:dragstart'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragstart?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondragstartcapture?:
    import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:drop'?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondrop?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  ondropcapture?: import('svelte/elements').DragEventHandler<HTMLDivElement> | null | undefined;
  'on:mousedown'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmousedown?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmousedowncapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:mouseenter'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseenter?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:mouseleave'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseleave?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:mousemove'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmousemove?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmousemovecapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:mouseout'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseout?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseoutcapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:mouseover'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseover?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseovercapture?:
    import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:mouseup'?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseup?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  onmouseupcapture?: import('svelte/elements').MouseEventHandler<HTMLDivElement> | null | undefined;
  'on:select'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onselect?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onselectcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:selectionchange'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onselectionchange?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onselectionchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:selectstart'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onselectstart?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onselectstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:touchcancel'?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchcancel?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchcancelcapture?:
    import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  'on:touchend'?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchend?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchendcapture?:
    import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  'on:touchmove'?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchmove?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchmovecapture?:
    import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  'on:touchstart'?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchstart?: import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  ontouchstartcapture?:
    import('svelte/elements').TouchEventHandler<HTMLDivElement> | null | undefined;
  'on:gotpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  ongotpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  ongotpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointercancel'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointercancel?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointercancelcapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointerdown'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerdown?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerdowncapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointerenter'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerenter?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerentercapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointerleave'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerleave?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerleavecapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointermove'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointermove?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointermovecapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointerout'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerout?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointeroutcapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointerover'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerover?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerovercapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:pointerup'?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerup?: import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onpointerupcapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:lostpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onlostpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  onlostpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLDivElement> | null | undefined;
  'on:gamepadconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLDivElement> | null | undefined;
  ongamepadconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLDivElement> | null | undefined;
  'on:gamepaddisconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLDivElement> | null | undefined;
  ongamepaddisconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLDivElement> | null | undefined;
  'on:scroll'?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  onscroll?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  onscrollcapture?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  'on:scrollend'?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  onscrollend?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  onscrollendcapture?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  'on:resize'?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  onresize?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  onresizecapture?: import('svelte/elements').UIEventHandler<HTMLDivElement> | null | undefined;
  'on:wheel'?: import('svelte/elements').WheelEventHandler<HTMLDivElement> | null | undefined;
  onwheel?: import('svelte/elements').WheelEventHandler<HTMLDivElement> | null | undefined;
  onwheelcapture?: import('svelte/elements').WheelEventHandler<HTMLDivElement> | null | undefined;
  'on:animationstart'?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  onanimationstart?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  onanimationstartcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  'on:animationend'?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  onanimationend?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  onanimationendcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  'on:animationiteration'?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  onanimationiteration?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  onanimationiterationcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLDivElement> | null | undefined;
  'on:transitionstart'?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitionstart?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitionstartcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  'on:transitionrun'?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitionrun?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitionruncapture?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  'on:transitionend'?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitionend?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitionendcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  'on:transitioncancel'?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitioncancel?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  ontransitioncancelcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLDivElement> | null | undefined;
  'on:outrostart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onoutrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onoutrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  'on:outroend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onoutroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onoutroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  'on:introstart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onintrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onintrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  'on:introend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onintroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  onintroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLDivElement> | null | undefined;
  'on:message'?: import('svelte/elements').MessageEventHandler<HTMLDivElement> | null | undefined;
  onmessage?: import('svelte/elements').MessageEventHandler<HTMLDivElement> | null | undefined;
  onmessagecapture?:
    import('svelte/elements').MessageEventHandler<HTMLDivElement> | null | undefined;
  'on:messageerror'?:
    import('svelte/elements').MessageEventHandler<HTMLDivElement> | null | undefined;
  onmessageerror?: import('svelte/elements').MessageEventHandler<HTMLDivElement> | null | undefined;
  onmessageerrorcapture?:
    import('svelte/elements').MessageEventHandler<HTMLDivElement> | null | undefined;
  'on:visibilitychange'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onvisibilitychange?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onvisibilitychangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:beforematch'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onbeforematch?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onbeforematchcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:cancel'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncancel?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  oncancelcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:close'?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onclose?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onclosecapture?: import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:fullscreenchange'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onfullscreenchange?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onfullscreenchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'on:fullscreenerror'?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onfullscreenerror?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  onfullscreenerrorcapture?:
    import('svelte/elements').EventHandler<Event, HTMLDivElement> | null | undefined;
  'bind:contentRect'?: DOMRectReadOnly | null | undefined;
  'bind:contentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:borderBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:devicePixelContentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:clientWidth'?: number | null | undefined;
  'bind:clientHeight'?: number | null | undefined;
  xmlns?: string | null | undefined;
};

export type FlatHTMLAttributesDivElementIndexSignatures = {
  [key: `data-${string}`]: any;
  [key: symbol]: false | import('svelte/attachments').Attachment<HTMLDivElement> | null | undefined;
};

export type FlatHTMLAttributesSpanElement = {
  accesskey?: string | null | undefined;
  autocapitalize?: 'characters' | 'off' | 'on' | 'none' | 'sentences' | 'words' | null | undefined;
  autofocus?: boolean | null | undefined;
  class?: import('svelte/elements').ClassValue | null | undefined;
  contenteditable?:
    import('svelte/elements').Booleanish | 'inherit' | 'plaintext-only' | null | undefined;
  contextmenu?: string | null | undefined;
  dir?: 'ltr' | 'rtl' | 'auto' | null | undefined;
  draggable?: import('svelte/elements').Booleanish | null | undefined;
  elementtiming?: string | null | undefined;
  enterkeyhint?:
    'enter' | 'done' | 'go' | 'next' | 'previous' | 'search' | 'send' | null | undefined;
  hidden?: boolean | '' | 'until-found' | null | undefined;
  id?: string | null | undefined;
  lang?: string | null | undefined;
  part?: string | null | undefined;
  placeholder?: string | null | undefined;
  slot?: string | null | undefined;
  spellcheck?: import('svelte/elements').Booleanish | null | undefined;
  style?: string | null | undefined;
  tabindex?: number | null | undefined;
  title?: string | null | undefined;
  translate?: '' | 'yes' | 'no' | null | undefined;
  inert?: boolean | null | undefined;
  popover?: '' | 'auto' | 'manual' | 'hint' | null | undefined;
  writingsuggestions?: import('svelte/elements').Booleanish | null | undefined;
  radiogroup?: string | null | undefined;
  role?: import('svelte/elements').AriaRole | null | undefined;
  about?: string | null | undefined;
  datatype?: string | null | undefined;
  inlist?: any;
  prefix?: string | null | undefined;
  property?: string | null | undefined;
  resource?: string | null | undefined;
  typeof?: string | null | undefined;
  vocab?: string | null | undefined;
  autosave?: string | null | undefined;
  color?: string | null | undefined;
  itemprop?: string | null | undefined;
  itemscope?: boolean | null | undefined;
  itemtype?: string | null | undefined;
  itemid?: string | null | undefined;
  itemref?: string | null | undefined;
  results?: number | null | undefined;
  security?: string | null | undefined;
  unselectable?: 'off' | 'on' | null | undefined;
  inputmode?:
    'none' | 'search' | 'text' | 'tel' | 'url' | 'email' | 'numeric' | 'decimal' | null | undefined;
  is?: string | null | undefined;
  'bind:innerHTML'?: string | null | undefined;
  'bind:textContent'?: string | null | undefined;
  'bind:innerText'?: string | null | undefined;
  'bind:focused'?: boolean | null | undefined;
  'bind:offsetWidth'?: number | null | undefined;
  'bind:offsetHeight'?: number | null | undefined;
  'aria-activedescendant'?: string | null | undefined;
  'aria-atomic'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-autocomplete'?: 'none' | 'list' | 'inline' | 'both' | null | undefined;
  'aria-busy'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-checked'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-colcount'?: number | null | undefined;
  'aria-colindex'?: number | null | undefined;
  'aria-colspan'?: number | null | undefined;
  'aria-controls'?: string | null | undefined;
  'aria-current'?:
    | import('svelte/elements').Booleanish
    | 'page'
    | 'step'
    | 'location'
    | 'date'
    | 'time'
    | null
    | undefined;
  'aria-describedby'?: string | null | undefined;
  'aria-details'?: string | null | undefined;
  'aria-disabled'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-dropeffect'?: 'none' | 'link' | 'copy' | 'execute' | 'move' | 'popup' | null | undefined;
  'aria-errormessage'?: string | null | undefined;
  'aria-expanded'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-flowto'?: string | null | undefined;
  'aria-grabbed'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-haspopup'?:
    | 'dialog'
    | import('svelte/elements').Booleanish
    | 'grid'
    | 'listbox'
    | 'menu'
    | 'tree'
    | null
    | undefined;
  'aria-hidden'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-invalid'?: import('svelte/elements').Booleanish | 'grammar' | 'spelling' | null | undefined;
  'aria-keyshortcuts'?: string | null | undefined;
  'aria-label'?: string | null | undefined;
  'aria-labelledby'?: string | null | undefined;
  'aria-level'?: number | null | undefined;
  'aria-live'?: 'off' | 'assertive' | 'polite' | null | undefined;
  'aria-modal'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiline'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-multiselectable'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-orientation'?: 'horizontal' | 'vertical' | null | undefined;
  'aria-owns'?: string | null | undefined;
  'aria-placeholder'?: string | null | undefined;
  'aria-posinset'?: number | null | undefined;
  'aria-pressed'?: boolean | 'true' | 'false' | 'mixed' | null | undefined;
  'aria-readonly'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-relevant'?:
    | 'text'
    | 'additions'
    | 'additions removals'
    | 'additions text'
    | 'all'
    | 'removals'
    | 'removals additions'
    | 'removals text'
    | 'text additions'
    | 'text removals'
    | null
    | undefined;
  'aria-required'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-roledescription'?: string | null | undefined;
  'aria-rowcount'?: number | null | undefined;
  'aria-rowindex'?: number | null | undefined;
  'aria-rowspan'?: number | null | undefined;
  'aria-selected'?: import('svelte/elements').Booleanish | null | undefined;
  'aria-setsize'?: number | null | undefined;
  'aria-sort'?: 'none' | 'ascending' | 'descending' | 'other' | null | undefined;
  'aria-valuemax'?: number | null | undefined;
  'aria-valuemin'?: number | null | undefined;
  'aria-valuenow'?: number | null | undefined;
  'aria-valuetext'?: string | null | undefined;
  children?: import('svelte').Snippet<[]>;
  'on:copy'?: import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  oncopy?: import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  oncopycapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  'on:cut'?: import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  oncut?: import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  oncutcapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  'on:paste'?: import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  onpaste?: import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  onpastecapture?:
    import('svelte/elements').ClipboardEventHandler<HTMLSpanElement> | null | undefined;
  'on:compositionend'?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  oncompositionend?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  oncompositionendcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  'on:compositionstart'?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  oncompositionstart?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  oncompositionstartcapture?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  'on:compositionupdate'?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  oncompositionupdate?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  oncompositionupdatecapture?:
    import('svelte/elements').CompositionEventHandler<HTMLSpanElement> | null | undefined;
  'on:focus'?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onfocus?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onfocuscapture?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  'on:focusin'?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onfocusin?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onfocusincapture?:
    import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  'on:focusout'?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onfocusout?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onfocusoutcapture?:
    import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  'on:blur'?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onblur?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  onblurcapture?: import('svelte/elements').FocusEventHandler<HTMLSpanElement> | null | undefined;
  'on:change'?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  onchange?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  onchangecapture?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  'on:beforeinput'?:
    import('svelte/elements').EventHandler<InputEvent, HTMLSpanElement> | null | undefined;
  onbeforeinput?:
    import('svelte/elements').EventHandler<InputEvent, HTMLSpanElement> | null | undefined;
  onbeforeinputcapture?:
    import('svelte/elements').EventHandler<InputEvent, HTMLSpanElement> | null | undefined;
  'on:input'?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  oninput?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  oninputcapture?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  'on:reset'?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  onreset?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  onresetcapture?: import('svelte/elements').FormEventHandler<HTMLSpanElement> | null | undefined;
  'on:submit'?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLSpanElement> | null | undefined;
  onsubmit?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLSpanElement> | null | undefined;
  onsubmitcapture?:
    import('svelte/elements').EventHandler<SubmitEvent, HTMLSpanElement> | null | undefined;
  'on:invalid'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oninvalid?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oninvalidcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:formdata'?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLSpanElement> | null | undefined;
  onformdata?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLSpanElement> | null | undefined;
  onformdatacapture?:
    import('svelte/elements').EventHandler<FormDataEvent, HTMLSpanElement> | null | undefined;
  'on:load'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onload?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onloadcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:error'?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerror?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  onerrorcapture?: import('svelte/elements').EventHandler<Event, Element> | null | undefined;
  'on:beforetoggle'?:
    import('svelte/elements').ToggleEventHandler<HTMLSpanElement> | null | undefined;
  onbeforetoggle?: import('svelte/elements').ToggleEventHandler<HTMLSpanElement> | null | undefined;
  onbeforetogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLSpanElement> | null | undefined;
  'on:toggle'?: import('svelte/elements').ToggleEventHandler<HTMLSpanElement> | null | undefined;
  ontoggle?: import('svelte/elements').ToggleEventHandler<HTMLSpanElement> | null | undefined;
  ontogglecapture?:
    import('svelte/elements').ToggleEventHandler<HTMLSpanElement> | null | undefined;
  'on:contentvisibilityautostatechange'?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLSpanElement>
    | null
    | undefined;
  oncontentvisibilityautostatechange?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLSpanElement>
    | null
    | undefined;
  oncontentvisibilityautostatechangecapture?:
    | import('svelte/elements').ContentVisibilityAutoStateChangeEventHandler<HTMLSpanElement>
    | null
    | undefined;
  'on:keydown'?: import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  onkeydown?: import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  onkeydowncapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  'on:keypress'?:
    import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  onkeypress?: import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  onkeypresscapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  'on:keyup'?: import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  onkeyup?: import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  onkeyupcapture?:
    import('svelte/elements').KeyboardEventHandler<HTMLSpanElement> | null | undefined;
  'on:abort'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onabort?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onabortcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:canplay'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncanplay?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncanplaycapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:canplaythrough'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncanplaythrough?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncanplaythroughcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:cuechange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncuechange?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncuechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:durationchange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  ondurationchange?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  ondurationchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:emptied'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onemptied?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onemptiedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:encrypted'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onencrypted?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onencryptedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:ended'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onended?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onendedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:loadeddata'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onloadeddata?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onloadeddatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:loadedmetadata'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onloadedmetadata?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onloadedmetadatacapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:loadstart'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onloadstart?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onloadstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:pause'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onpause?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onpausecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:play'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onplay?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onplaycapture?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:playing'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onplaying?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onplayingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:progress'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onprogress?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onprogresscapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:ratechange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onratechange?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onratechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:seeked'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onseeked?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onseekedcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:seeking'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onseeking?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onseekingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:stalled'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onstalled?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onstalledcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:suspend'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onsuspend?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onsuspendcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:timeupdate'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  ontimeupdate?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  ontimeupdatecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:volumechange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onvolumechange?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onvolumechangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:waiting'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onwaiting?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onwaitingcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:auxclick'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onauxclick?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onauxclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:click'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onclick?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onclickcapture?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:contextmenu'?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  oncontextmenu?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  oncontextmenucapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:dblclick'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  ondblclick?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  ondblclickcapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:drag'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondrag?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragcapture?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:dragend'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragend?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragendcapture?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:dragenter'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragenter?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragentercapture?:
    import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:dragexit'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragexit?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragexitcapture?:
    import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:dragleave'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragleave?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragleavecapture?:
    import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:dragover'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragover?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragovercapture?:
    import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:dragstart'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragstart?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondragstartcapture?:
    import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:drop'?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondrop?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  ondropcapture?: import('svelte/elements').DragEventHandler<HTMLSpanElement> | null | undefined;
  'on:mousedown'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmousedown?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmousedowncapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:mouseenter'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseenter?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:mouseleave'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseleave?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:mousemove'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmousemove?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmousemovecapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:mouseout'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseout?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseoutcapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:mouseover'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseover?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseovercapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:mouseup'?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseup?: import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  onmouseupcapture?:
    import('svelte/elements').MouseEventHandler<HTMLSpanElement> | null | undefined;
  'on:select'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onselect?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onselectcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:selectionchange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onselectionchange?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onselectionchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:selectstart'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onselectstart?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onselectstartcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:touchcancel'?:
    import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchcancel?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchcancelcapture?:
    import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  'on:touchend'?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchend?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchendcapture?:
    import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  'on:touchmove'?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchmove?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchmovecapture?:
    import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  'on:touchstart'?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchstart?: import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  ontouchstartcapture?:
    import('svelte/elements').TouchEventHandler<HTMLSpanElement> | null | undefined;
  'on:gotpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  ongotpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  ongotpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointercancel'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointercancel?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointercancelcapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointerdown'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerdown?: import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerdowncapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointerenter'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerenter?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerentercapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointerleave'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerleave?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerleavecapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointermove'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointermove?: import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointermovecapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointerout'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerout?: import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointeroutcapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointerover'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerover?: import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerovercapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:pointerup'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerup?: import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onpointerupcapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:lostpointercapture'?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onlostpointercapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  onlostpointercapturecapture?:
    import('svelte/elements').PointerEventHandler<HTMLSpanElement> | null | undefined;
  'on:gamepadconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLSpanElement> | null | undefined;
  ongamepadconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLSpanElement> | null | undefined;
  'on:gamepaddisconnected'?:
    import('svelte/elements').GamepadEventHandler<HTMLSpanElement> | null | undefined;
  ongamepaddisconnected?:
    import('svelte/elements').GamepadEventHandler<HTMLSpanElement> | null | undefined;
  'on:scroll'?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  onscroll?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  onscrollcapture?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  'on:scrollend'?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  onscrollend?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  onscrollendcapture?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  'on:resize'?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  onresize?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  onresizecapture?: import('svelte/elements').UIEventHandler<HTMLSpanElement> | null | undefined;
  'on:wheel'?: import('svelte/elements').WheelEventHandler<HTMLSpanElement> | null | undefined;
  onwheel?: import('svelte/elements').WheelEventHandler<HTMLSpanElement> | null | undefined;
  onwheelcapture?: import('svelte/elements').WheelEventHandler<HTMLSpanElement> | null | undefined;
  'on:animationstart'?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  onanimationstart?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  onanimationstartcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  'on:animationend'?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  onanimationend?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  onanimationendcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  'on:animationiteration'?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  onanimationiteration?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  onanimationiterationcapture?:
    import('svelte/elements').AnimationEventHandler<HTMLSpanElement> | null | undefined;
  'on:transitionstart'?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitionstart?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitionstartcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  'on:transitionrun'?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitionrun?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitionruncapture?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  'on:transitionend'?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitionend?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitionendcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  'on:transitioncancel'?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitioncancel?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  ontransitioncancelcapture?:
    import('svelte/elements').TransitionEventHandler<HTMLSpanElement> | null | undefined;
  'on:outrostart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onoutrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onoutrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  'on:outroend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onoutroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onoutroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  'on:introstart'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onintrostart?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onintrostartcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  'on:introend'?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onintroend?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  onintroendcapture?:
    import('svelte/elements').EventHandler<CustomEvent<null>, HTMLSpanElement> | null | undefined;
  'on:message'?: import('svelte/elements').MessageEventHandler<HTMLSpanElement> | null | undefined;
  onmessage?: import('svelte/elements').MessageEventHandler<HTMLSpanElement> | null | undefined;
  onmessagecapture?:
    import('svelte/elements').MessageEventHandler<HTMLSpanElement> | null | undefined;
  'on:messageerror'?:
    import('svelte/elements').MessageEventHandler<HTMLSpanElement> | null | undefined;
  onmessageerror?:
    import('svelte/elements').MessageEventHandler<HTMLSpanElement> | null | undefined;
  onmessageerrorcapture?:
    import('svelte/elements').MessageEventHandler<HTMLSpanElement> | null | undefined;
  'on:visibilitychange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onvisibilitychange?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onvisibilitychangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:beforematch'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onbeforematch?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onbeforematchcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:cancel'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncancel?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  oncancelcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:close'?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onclose?: import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onclosecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:fullscreenchange'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onfullscreenchange?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onfullscreenchangecapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'on:fullscreenerror'?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onfullscreenerror?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  onfullscreenerrorcapture?:
    import('svelte/elements').EventHandler<Event, HTMLSpanElement> | null | undefined;
  'bind:contentRect'?: DOMRectReadOnly | null | undefined;
  'bind:contentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:borderBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:devicePixelContentBoxSize'?: ResizeObserverSize[] | null | undefined;
  'bind:clientWidth'?: number | null | undefined;
  'bind:clientHeight'?: number | null | undefined;
  xmlns?: string | null | undefined;
};

export type FlatHTMLAttributesSpanElementIndexSignatures = {
  [key: `data-${string}`]: any;
  [key: symbol]:
    false | import('svelte/attachments').Attachment<HTMLSpanElement> | null | undefined;
};

import type { ComponentSchema } from '../../schema-types';

const schema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object',
  properties: {
    shape: {
      enum: ['filled', 'extended'],
      description: 'Shape. `filled` = circle, `extended` = pill.',
      default: 'filled',
    },
    size: {
      enum: ['sm', 'md', 'lg'],
      description: 'Size of the floating action.',
      default: 'md',
    },
    variant: {
      enum: ['primary', 'secondary', 'surface'],
      description: 'Color palette.',
      default: 'primary',
    },
    disabled: {
      type: 'boolean',
      description: 'When true, disables the button and prevents interaction.',
      default: false,
    },
    href: {
      type: 'string',
      description: 'Render as an anchor `<a>` element with this href.',
    },
    class: {
      type: 'string',
      description: 'Custom class merged with `.cinder-floating-action`.',
    },
  },
  additionalProperties: false,
  metadata: {
    unsupportedProps: [
      {
        name: 'children',
        reason: 'function-or-snippet',
        description:
          'The icon (or icon + label for extended shape). Always provide `aria-label` when\nthe floating action renders an icon without visible text — i.e. the `filled` shape.',
      },
      {
        name: 'on:abort',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:animationend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:animationiteration',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:animationstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:auxclick',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:beforeinput',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:beforematch',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:beforetoggle',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:blur',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:cancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:canplay',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:canplaythrough',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:change',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:click',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:close',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:compositionend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:compositionstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:compositionupdate',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:contentvisibilityautostatechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:contextmenu',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:copy',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:cuechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:cut',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dblclick',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:drag',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dragend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dragenter',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dragexit',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dragleave',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dragover',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:dragstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:drop',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:durationchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:emptied',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:encrypted',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:ended',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:error',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:focus',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:focusin',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:focusout',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:formdata',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:fullscreenchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:fullscreenerror',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:gamepadconnected',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:gamepaddisconnected',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:gotpointercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:input',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:introend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:introstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:invalid',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:keydown',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:keypress',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:keyup',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:load',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:loadeddata',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:loadedmetadata',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:loadstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:lostpointercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:message',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:messageerror',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mousedown',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mouseenter',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mouseleave',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mousemove',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mouseout',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mouseover',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:mouseup',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:outroend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:outrostart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:paste',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pause',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:play',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:playing',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointercancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointerdown',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointerenter',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointerleave',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointermove',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointerout',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointerover',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:pointerup',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:progress',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:ratechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:reset',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:resize',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:scroll',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:scrollend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:seeked',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:seeking',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:select',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:selectionchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:selectstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:stalled',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:submit',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:suspend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:timeupdate',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:toggle',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:touchcancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:touchend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:touchmove',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:touchstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:transitioncancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:transitionend',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:transitionrun',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:transitionstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:visibilitychange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:volumechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:waiting',
        reason: 'function-or-snippet',
      },
      {
        name: 'on:wheel',
        reason: 'function-or-snippet',
      },
      {
        name: 'onabort',
        reason: 'function-or-snippet',
      },
      {
        name: 'onabortcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onanimationend',
        reason: 'function-or-snippet',
      },
      {
        name: 'onanimationendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onanimationiteration',
        reason: 'function-or-snippet',
      },
      {
        name: 'onanimationiterationcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onanimationstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'onanimationstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onauxclick',
        reason: 'function-or-snippet',
      },
      {
        name: 'onauxclickcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onbeforeinput',
        reason: 'function-or-snippet',
      },
      {
        name: 'onbeforeinputcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onbeforematch',
        reason: 'function-or-snippet',
      },
      {
        name: 'onbeforematchcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onbeforetoggle',
        reason: 'function-or-snippet',
      },
      {
        name: 'onbeforetogglecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onblur',
        reason: 'function-or-snippet',
      },
      {
        name: 'onblurcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncancelcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncanplay',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncanplaycapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncanplaythrough',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncanplaythroughcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'onchangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onclick',
        reason: 'function-or-snippet',
      },
      {
        name: 'onclickcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onclose',
        reason: 'function-or-snippet',
      },
      {
        name: 'onclosecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncompositionend',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncompositionendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncompositionstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncompositionstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncompositionupdate',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncompositionupdatecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncontentvisibilityautostatechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncontentvisibilityautostatechangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncontextmenu',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncontextmenucapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncopy',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncopycapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncuechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncuechangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncut',
        reason: 'function-or-snippet',
      },
      {
        name: 'oncutcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondblclick',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondblclickcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondrag',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragend',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragenter',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragentercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragexit',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragexitcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragleave',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragleavecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragover',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragovercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondragstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondrop',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondropcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondurationchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'ondurationchangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onemptied',
        reason: 'function-or-snippet',
      },
      {
        name: 'onemptiedcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onencrypted',
        reason: 'function-or-snippet',
      },
      {
        name: 'onencryptedcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onended',
        reason: 'function-or-snippet',
      },
      {
        name: 'onendedcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onerror',
        reason: 'function-or-snippet',
      },
      {
        name: 'onerrorcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfocus',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfocuscapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfocusin',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfocusincapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfocusout',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfocusoutcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onformdata',
        reason: 'function-or-snippet',
      },
      {
        name: 'onformdatacapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfullscreenchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfullscreenchangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfullscreenerror',
        reason: 'function-or-snippet',
      },
      {
        name: 'onfullscreenerrorcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ongamepadconnected',
        reason: 'function-or-snippet',
      },
      {
        name: 'ongamepaddisconnected',
        reason: 'function-or-snippet',
      },
      {
        name: 'ongotpointercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ongotpointercapturecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oninput',
        reason: 'function-or-snippet',
      },
      {
        name: 'oninputcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onintroend',
        reason: 'function-or-snippet',
      },
      {
        name: 'onintroendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onintrostart',
        reason: 'function-or-snippet',
      },
      {
        name: 'onintrostartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'oninvalid',
        reason: 'function-or-snippet',
      },
      {
        name: 'oninvalidcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onkeydown',
        reason: 'function-or-snippet',
      },
      {
        name: 'onkeydowncapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onkeypress',
        reason: 'function-or-snippet',
      },
      {
        name: 'onkeypresscapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onkeyup',
        reason: 'function-or-snippet',
      },
      {
        name: 'onkeyupcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onload',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadeddata',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadeddatacapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadedmetadata',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadedmetadatacapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'onloadstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onlostpointercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onlostpointercapturecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmessage',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmessagecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmessageerror',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmessageerrorcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmousedown',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmousedowncapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseenter',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseleave',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmousemove',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmousemovecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseout',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseoutcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseover',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseovercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseup',
        reason: 'function-or-snippet',
      },
      {
        name: 'onmouseupcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onoutroend',
        reason: 'function-or-snippet',
      },
      {
        name: 'onoutroendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onoutrostart',
        reason: 'function-or-snippet',
      },
      {
        name: 'onoutrostartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpaste',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpastecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpause',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpausecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onplay',
        reason: 'function-or-snippet',
      },
      {
        name: 'onplaycapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onplaying',
        reason: 'function-or-snippet',
      },
      {
        name: 'onplayingcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointercancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointercancelcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerdown',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerdowncapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerenter',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerentercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerleave',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerleavecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointermove',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointermovecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerout',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointeroutcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerover',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerovercapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerup',
        reason: 'function-or-snippet',
      },
      {
        name: 'onpointerupcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onprogress',
        reason: 'function-or-snippet',
      },
      {
        name: 'onprogresscapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onratechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'onratechangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onreset',
        reason: 'function-or-snippet',
      },
      {
        name: 'onresetcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onresize',
        reason: 'function-or-snippet',
      },
      {
        name: 'onresizecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onscroll',
        reason: 'function-or-snippet',
      },
      {
        name: 'onscrollcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onscrollend',
        reason: 'function-or-snippet',
      },
      {
        name: 'onscrollendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onseeked',
        reason: 'function-or-snippet',
      },
      {
        name: 'onseekedcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onseeking',
        reason: 'function-or-snippet',
      },
      {
        name: 'onseekingcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onselect',
        reason: 'function-or-snippet',
      },
      {
        name: 'onselectcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onselectionchange',
        reason: 'function-or-snippet',
      },
      {
        name: 'onselectionchangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onselectstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'onselectstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onstalled',
        reason: 'function-or-snippet',
      },
      {
        name: 'onstalledcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onsubmit',
        reason: 'function-or-snippet',
      },
      {
        name: 'onsubmitcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onsuspend',
        reason: 'function-or-snippet',
      },
      {
        name: 'onsuspendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontimeupdate',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontimeupdatecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontoggle',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontogglecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchcancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchcancelcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchend',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchmove',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchmovecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontouchstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitioncancel',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitioncancelcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitionend',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitionendcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitionrun',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitionruncapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitionstart',
        reason: 'function-or-snippet',
      },
      {
        name: 'ontransitionstartcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onvisibilitychange',
        reason: 'function-or-snippet',
      },
      {
        name: 'onvisibilitychangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onvolumechange',
        reason: 'function-or-snippet',
      },
      {
        name: 'onvolumechangecapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onwaiting',
        reason: 'function-or-snippet',
      },
      {
        name: 'onwaitingcapture',
        reason: 'function-or-snippet',
      },
      {
        name: 'onwheel',
        reason: 'function-or-snippet',
      },
      {
        name: 'onwheelcapture',
        reason: 'function-or-snippet',
      },
    ],
  },
} satisfies ComponentSchema;

export default schema as ComponentSchema;

/**
 * Builds the `srcdoc` of a static HTML or SVG artifact preview so the document makes no network
 * request and cannot navigate.
 *
 * Two layers, because neither is enough alone:
 *
 * 1. A Content-Security-Policy `<meta>` is the first node of the document. The browser applies it
 *    to everything parsed after it, so markup in the artifact can only add further policies, which
 *    intersect with this one and never relax it. `default-src 'none'` blocks every fetch kind
 *    (images, fonts, stylesheets, `@import`, frames, objects, media, workers, `data:` and `blob:`
 *    included); only inline styles are permitted. `base-uri` and `form-action` are not covered by
 *    `default-src`, so they are listed.
 * 2. The artifact is parsed with `DOMParser` (which neither runs scripts nor loads resources) and
 *    stripped of what CSP cannot stop: link targets, so an activated link neither navigates the
 *    frame nor opens a tab, and refresh directives, which navigate the frame by themselves. It also
 *    drops elements and attributes that exist only to fetch a subresource, so those never reach the
 *    CSP as violations.
 *
 * The frame keeps `sandbox=""`, so scripts stay disabled whatever the artifact contains.
 */

const STATIC_PREVIEW_POLICY = [
  "default-src 'none'",
  "style-src 'unsafe-inline'",
  "base-uri 'none'",
  "form-action 'none'",
].join('; ');

const POLICY_META = `<meta http-equiv="Content-Security-Policy" content="${STATIC_PREVIEW_POLICY}">`;

/** Elements that exist to load or navigate to another resource, or to hold inert script. */
const REMOVED_ELEMENTS = new Set([
  'applet',
  'audio',
  'base',
  'embed',
  'feimage',
  'frame',
  'frameset',
  'iframe',
  'image',
  'img',
  'link',
  'object',
  'picture',
  'script',
  'source',
  'template',
  'track',
  'video',
]);

/** Attributes whose value is a resource URL on any element. */
const REMOVED_ATTRIBUTES = new Set([
  'action',
  'archive',
  'background',
  'codebase',
  'data',
  'dynsrc',
  'formaction',
  'imagesrcset',
  'longdesc',
  'lowsrc',
  'manifest',
  'ping',
  'poster',
  'src',
  'srcset',
]);

const ANIMATED_HREF = /href/i;

function localName(name: string): string {
  const separator = name.lastIndexOf(':');
  return (separator === -1 ? name : name.slice(separator + 1)).toLowerCase();
}

function shouldRemoveElement(element: Element): boolean {
  const name = element.localName.toLowerCase();
  if (REMOVED_ELEMENTS.has(name)) return true;
  if (name === 'meta') {
    return element.getAttribute('http-equiv')?.trim().toLowerCase() === 'refresh';
  }
  // SVG animation can rewrite a link target after load.
  if (name === 'set' || name === 'animate') {
    return ANIMATED_HREF.test(element.getAttribute('attributeName') ?? '');
  }
  return false;
}

function stripAttributes(element: Element): number {
  let removed = 0;
  const isAnchor = element.localName === 'a' || element.localName === 'area';
  for (const attribute of Array.from(element.attributes)) {
    const name = localName(attribute.name);
    if (REMOVED_ATTRIBUTES.has(name)) {
      element.removeAttributeNode(attribute);
      removed += 1;
    } else if (name === 'href') {
      // Authored links keep their text but go nowhere. A reference to another part of the same
      // document, such as `<use href="#shape">`, is the only other `href` a static preview needs.
      if (isAnchor || !attribute.value.trim().startsWith('#')) {
        element.removeAttributeNode(attribute);
        removed += 1;
      }
    } else if (isAnchor && name === 'target') {
      element.removeAttributeNode(attribute);
      removed += 1;
    }
  }
  return removed;
}

/** Strips a parsed document in place and says how many nodes and attributes it removed. */
function sanitize(parsed: Document): number {
  let changes = 0;
  for (const element of Array.from(parsed.querySelectorAll('*'))) {
    if (shouldRemoveElement(element)) {
      element.remove();
      changes += 1;
    } else {
      changes += stripAttributes(element);
    }
  }
  return changes;
}

/** Wrap SVG in a minimal HTML document that centres it. */
export function wrapSvgInHtml(svg: string): string {
  return `<!DOCTYPE html><html><body style="margin:0;display:flex;align-items:center;justify-content:center;min-height:100vh;">${svg}</body></html>`;
}

const EMPTY_DOCUMENT = `<!DOCTYPE html><html><head>${POLICY_META}</head><body></body></html>`;
const MAX_PASSES = 4;

/**
 * Returns a self-contained, network-inert document for the given HTML source.
 *
 * Serializing a parsed tree and parsing the result is not always the identity, so a link or
 * refresh could in principle reappear on the second parse. The document is therefore
 * re-parsed and re-checked until a pass finds nothing left to remove, and the document the
 * browser will parse is the one that passed. A source that never settles gets an empty document.
 */
export function staticArtifactDocument(source: string): string {
  if (typeof DOMParser === 'undefined') return EMPTY_DOCUMENT;
  const parser = new DOMParser();
  let markup = source;
  for (let pass = 0; pass < MAX_PASSES; pass += 1) {
    const parsed = parser.parseFromString(markup, 'text/html');
    const changes = sanitize(parsed);
    if (changes === 0 && pass > 0) {
      parsed.head.insertAdjacentHTML('afterbegin', POLICY_META);
    }
    const doctype = parsed.compatMode === 'BackCompat' ? '' : '<!DOCTYPE html>';
    markup = `${doctype}${parsed.documentElement.outerHTML}`;
    if (changes === 0 && pass > 0) return markup;
  }
  return EMPTY_DOCUMENT;
}

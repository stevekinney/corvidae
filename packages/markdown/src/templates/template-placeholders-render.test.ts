/**
 * Exhaustive tests for template placeholder domain logic.
 * DEP-582: Pure functions with no ProseMirror or DOM dependencies.
 * DEP-625: Comprehensive security tests for prototype pollution and XSS prevention.
 */

import { describe, expect, it } from 'bun:test';

import type { PlaceholderResolutionOptions } from './types.js';

/** Definitions that permit no placeholder paths, for templates without tokens. */
const NO_PLACEHOLDERS: PlaceholderResolutionOptions = { definitions: { candidates: [] } };

/** Options declaring each path with unknown types. */
function declare(...paths: string[]): PlaceholderResolutionOptions {
  return { definitions: { candidates: paths.map((path) => ({ path })) } };
}

describe('DEP-625: XSS prevention via renderTemplate', () => {
  // Tests use dynamic imports to avoid loading the heavy markdown rendering
  // pipeline at module load time for lightweight function tests
  describe('script tag removal', () => {
    it('removes <script> tags from template', async () => {
      const { renderTemplate } = await import('./template-render.js');
      // Markdown parser treats the text "Hello" after raw HTML differently, so we wrap in markdown context
      const html = renderTemplate('Hello <script>alert(1)</script> World', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('<script>');
      expect(html).toContain('Hello');
      expect(html).toContain('World');
    });

    it('removes <script> tags with attributes', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        'Text <script type="text/javascript">alert(1)</script> more',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('type="text/javascript"');
    });

    it('removes multiple <script> tags', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        'Start <script>alert(1)</script> Safe <script>alert(2)</script> End',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('<script>');
      expect(html).toContain('Safe');
    });

    it('removes <script> tags mixed with placeholders', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        'Hello <script>alert(1)</script> {{name}}',
        { name: 'Alice' },
        declare('name'),
      );

      expect(html).not.toContain('<script>');
      expect(html).toContain('Alice');
    });
  });

  describe('event handler removal', () => {
    it('removes onerror handler from img tag', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('<img src=x onerror=alert(1)>', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('onerror');
      expect(html).not.toContain('alert');
    });

    it('removes onclick handler from div', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('<div onclick=alert(1)>Click me</div>', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('onclick');
      expect(html).not.toContain('alert');
    });

    it('removes onload handler from body', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('<body onload=alert(1)>Content</body>', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('onload');
      expect(html).not.toContain('alert');
    });

    it('removes onmouseover handler', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('<span onmouseover=alert(1)>Hover</span>', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('onmouseover');
      expect(html).not.toContain('alert');
    });

    it('removes onfocus handler from input', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('<input onfocus=alert(1) value="test">', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('onfocus');
      expect(html).not.toContain('alert');
    });
  });

  describe('dangerous URL blocking', () => {
    it('blocks javascript: URLs in links', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('[Click me](javascript:alert(1))', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('alert');
    });

    it('blocks data: URLs in images by default', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '![img](data:text/html,<script>alert(1)</script>)',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('data:');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });

    it('blocks vbscript: URLs', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('[Click](vbscript:msgbox(1))', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('vbscript:');
      expect(html).not.toContain('msgbox');
    });

    it('blocks file: URLs', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('[Local file](file:///etc/passwd)', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('file:');
      expect(html).not.toContain('/etc/passwd');
    });
  });

  describe('safe content preservation', () => {
    it('preserves markdown headings', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('# Hello {{name}}', { name: 'World' }, declare('name'));

      expect(html).toContain('<h1');
      expect(html).toContain('Hello World');
      expect(html).toContain('</h1>');
    });

    it('preserves markdown emphasis', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('**bold** and *italic*', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<strong>bold</strong>');
      expect(html).toContain('<em>italic</em>');
    });

    it('preserves safe links (https)', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('[Link](https://example.com)', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<a');
      expect(html).toContain('href="https://example.com"');
      expect(html).toContain('Link');
      expect(html).toContain('</a>');
    });

    it('preserves safe links (http)', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('[Link](http://example.com)', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<a');
      expect(html).toContain('href="http://example.com"');
    });

    it('preserves mailto links', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('[Email](mailto:test@example.com)', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<a');
      expect(html).toContain('href="mailto:test@example.com"');
    });

    it('preserves markdown lists', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('- Item 1\n- Item 2', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<ul');
      expect(html).toContain('<li');
      expect(html).toContain('Item 1');
      expect(html).toContain('Item 2');
    });

    it('preserves code blocks', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('`inline code`', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<code');
      expect(html).toContain('inline code');
    });

    it('preserves blockquotes', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('> Quote', {}, NO_PLACEHOLDERS);

      expect(html).toContain('<blockquote');
      expect(html).toContain('Quote');
    });
  });

  describe('mixed malicious and safe content', () => {
    it('sanitizes XSS while preserving safe markdown', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '# Title\n\n<script>alert(1)</script>\n\n**Safe text** {{name}}',
        { name: 'Alice' },
        declare('name'),
      );

      expect(html).toContain('<h1');
      expect(html).toContain('Title');
      expect(html).toContain('<strong>Safe text</strong>');
      expect(html).toContain('Alice');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });

    it('sanitizes event handlers while preserving content', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '**Bold** <div onclick=alert(1)>Click</div> *italic*',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).toContain('<strong>Bold</strong>');
      expect(html).toContain('<em>italic</em>');
      expect(html).not.toContain('onclick');
      expect(html).not.toContain('alert');
    });

    it('renders placeholder values that contain XSS attempts as literal text by default', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        'Hello {{user}}',
        { user: '<script>alert(1)</script>' },
        declare('user'),
      );

      // Text mode encodes the value, so it renders as visible text rather than markup.
      expect(html).not.toContain('<script>');
      expect(html).toContain('Hello');
      expect(html).toMatch(/(&lt;|&#x3C;)script(&gt;|&#x3E;|>)alert\(1\)/);
    });

    it('sanitizes Markdown and HTML contributed by values in markdown mode', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        'Hello {{user}}',
        {
          user: '<script>alert(1)</script> <img src=x onerror=alert(2)> [x](javascript:alert(3)) ![i](javascript:alert(4))',
        },
        { ...declare('user'), valueMode: 'markdown' },
      );

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('onerror');
      expect(html).not.toContain('javascript:');
      expect(html).toContain('<a href="#">x</a>');
    });

    it('keeps blocked placeholders visible instead of resolving them and sanitizes output', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '{{constructor.isAdmin}} <script>alert(1)</script>',
        {},
        NO_PLACEHOLDERS,
      );

      // Prototype pollution blocked: the token is left as literal text and
      // nothing from Object.prototype is substituted; the script is removed.
      expect(html).toContain('{{constructor.isAdmin}}');
      expect(html).not.toContain('function');
      expect(html).not.toContain('<script>');
    });
  });

  describe('value modes', () => {
    it('renders **important** literally by default and as strong text only after opt-in', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const values = { value: '**important**' };

      const literal = renderTemplate('{{value}}', values, declare('value'));
      const markdown = renderTemplate('{{value}}', values, {
        ...declare('value'),
        valueMode: 'markdown',
      });

      expect(literal).toContain('**important**');
      expect(literal).not.toContain('<strong>');
      expect(markdown).toContain('<strong>important</strong>');
    });

    it('throws PlaceholderTemplateError without rendering in strict mode', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const { PlaceholderTemplateError } = await import('./template-placeholders.js');

      expect(() =>
        renderTemplate('{{missing}}', {}, { ...declare('missing'), unresolved: 'error' }),
      ).toThrow(PlaceholderTemplateError);
    });
  });

  describe('attribute-based XSS attempts', () => {
    it('removes style attribute with expression()', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '<div style="width:expression(alert(1))">Test</div>',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('expression');
      expect(html).not.toContain('alert');
    });

    it('removes javascript: in style url()', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '<div style="background:url(javascript:alert(1))">Test</div>',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('alert');
    });

    it('removes srcdoc attribute from iframe', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '<iframe srcdoc="<script>alert(1)</script>"></iframe>',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('srcdoc');
      expect(html).not.toContain('<script>');
      expect(html).not.toContain('alert');
    });

    it('removes formaction attribute', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '<button formaction="javascript:alert(1)">Click</button>',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('formaction');
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('alert');
    });
  });

  describe('edge cases and complex attacks', () => {
    it('handles nested HTML entities', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('&lt;script&gt;alert(1)&lt;/script&gt;', {}, NO_PLACEHOLDERS);

      // HTML entities in markdown are treated as plain text
      // The markdown renderer wraps text in block elements (e.g., <p>)
      expect(html).not.toContain('<script>');
      // Verify the entity-encoded content is safely rendered
      // rehype-stringify encodes < as &#x3C; but may leave > unencoded (both are valid HTML)
      expect(html).toMatch(/(&lt;|&#x3C;)/);
      expect(html).toContain('alert(1)');
      // > can appear as &gt;, &#x3E;, or unencoded (all valid)
      expect(html).toMatch(/(&gt;|&#x3E;|>)/);
    });

    it('blocks case variations of script tag', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('Text <ScRiPt>alert(1)</ScRiPt> more', {}, NO_PLACEHOLDERS);

      expect(html).not.toContain('<ScRiPt>');
      expect(html).not.toContain('<script>');
    });

    it('handles SVG-based XSS attempts', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        'Text <svg><script>alert(1)</script></svg> more',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('<script>');
      expect(html).not.toContain('<svg>');
      // The text inside is preserved
      expect(html).toContain('alert(1)');
    });

    it('blocks object/embed tags', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '<object data="javascript:alert(1)"></object>',
        {},
        NO_PLACEHOLDERS,
      );

      expect(html).not.toContain('<object');
      expect(html).not.toContain('javascript:');
      expect(html).not.toContain('alert');
    });

    it('handles empty template gracefully', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate('', {}, NO_PLACEHOLDERS);

      expect(html).toBe('');
    });

    it('handles template with only placeholders', async () => {
      const { renderTemplate } = await import('./template-render.js');
      const html = renderTemplate(
        '{{a}} {{b}} {{c}}',
        { a: '1', b: '2', c: '3' },
        declare('a', 'b', 'c'),
      );

      expect(html).toContain('1');
      expect(html).toContain('2');
      expect(html).toContain('3');
    });
  });
});

import { expect, test } from '@playwright/test';

import { functionalResidualRoute } from './functional-residual-route.ts';

// Rendered Markdown's shared rhythm lives in Cinder's utilities layer. This spec builds the
// structure the Markdown component renders (headings, the table scroller, a code-block node)
// around the fixture page's CodeBlock and measures it in a real browser.
const EXAMPLE = '#example-mount-delayed-highlighting';

type RhythmMetrics = {
  editorHeadingSize: string;
  headingSizes: Record<string, string>;
  tokenSizes: Record<string, string>;
  headingWeights: Record<string, string>;
  semiboldWeight: string;
  cellTextStart: number;
  codeTextStart: number;
};

test('Markdown headings step down from the page scale and framed blocks share one text inset', async ({
  page,
}) => {
  await page.goto(functionalResidualRoute, { waitUntil: 'domcontentloaded' });
  const block = page.locator(`${EXAMPLE} .cinder-code-block`).first();
  await expect(block.locator('.cinder-code-block__pre')).toBeVisible();

  const metrics = await block.evaluate((element): RhythmMetrics => {
    const content = document.createElement('div');
    content.className = 'cinder-markdown cinder-markdown-content';
    content.style.inlineSize = '480px';
    // An editing surface shares the rhythm class but not the Markdown component's, and keeps its
    // own heading scale.
    const editorSurface = document.createElement('div');
    editorSurface.className = 'cinder-markdown-content';
    const editorHeading = document.createElement('h1');
    editorHeading.textContent = 'Editor heading';
    editorSurface.append(editorHeading);
    element.before(editorSurface);
    for (const level of ['h1', 'h2', 'h3', 'h4', 'h5', 'h6']) {
      const heading = document.createElement(level);
      heading.textContent = `Heading ${level}`;
      content.append(heading);
    }
    const table = document.createElement('div');
    table.dataset['cinderMarkdownNode'] = 'table';
    table.innerHTML =
      '<div class="cinder-markdown-table"><div class="cinder-markdown-table-frame">' +
      '<div class="cinder-markdown-table-scroller"><table><thead><tr><th>Name</th></tr></thead>' +
      '<tbody><tr><td>Value</td></tr></tbody></table></div></div></div>';
    content.append(table);
    const codeNode = document.createElement('div');
    codeNode.dataset['cinderMarkdownNode'] = 'code-block';
    element.before(content);
    codeNode.append(element);
    content.append(codeNode);

    const probe = document.createElement('span');
    content.append(probe);
    const tokenSize = (token: string): string => {
      probe.style.fontSize = `var(${token})`;
      return getComputedStyle(probe).fontSize;
    };
    const tokenSizes = {
      h1: tokenSize('--cinder-text-xl'),
      h2: tokenSize('--cinder-text-lg'),
      h3: tokenSize('--cinder-text-base'),
    };
    probe.style.fontWeight = 'var(--cinder-font-semibold)';
    const semiboldWeight = getComputedStyle(probe).fontWeight;

    const headingSizes: Record<string, string> = {};
    const headingWeights: Record<string, string> = {};
    for (const heading of content.querySelectorAll('h1, h2, h3, h4, h5, h6')) {
      const styles = getComputedStyle(heading);
      headingSizes[heading.tagName.toLowerCase()] = styles.fontSize;
      headingWeights[heading.tagName.toLowerCase()] = styles.fontWeight;
    }

    const textStart = (box: Element): number => {
      const styles = getComputedStyle(box);
      return box.getBoundingClientRect().left + Number.parseFloat(styles.paddingInlineStart);
    };
    const cell = content.querySelector('td');
    const pre = element.querySelector('.cinder-code-block__viewport pre');
    if (cell === null || pre === null) throw new Error('Missing table cell or code pre.');

    return {
      editorHeadingSize: getComputedStyle(editorHeading).fontSize,
      headingSizes,
      tokenSizes,
      headingWeights,
      semiboldWeight,
      cellTextStart: textStart(cell),
      codeTextStart: textStart(pre),
    };
  });

  expect(metrics.headingSizes['h1']).toBe(metrics.tokenSizes['h1']);
  expect(metrics.editorHeadingSize).not.toBe(metrics.tokenSizes['h1']);
  expect(metrics.headingSizes['h2']).toBe(metrics.tokenSizes['h2']);
  for (const level of ['h3', 'h4', 'h5', 'h6']) {
    expect(metrics.headingSizes[level]).toBe(metrics.tokenSizes['h3']);
    expect(metrics.headingWeights[level]).toBe(metrics.semiboldWeight);
  }
  expect(Math.abs(metrics.cellTextStart - metrics.codeTextStart)).toBeLessThanOrEqual(0.5);
});

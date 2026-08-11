/**
 * The reply Markdown subset. `parse` is pure, which is the point of splitting
 * it from `toDOM`: the half that decides what is markup and what is literal
 * text can be checked without a browser. Run with:
 *   node --test test/markdown.test.js
 */
const test = require('node:test');
const assert = require('node:assert');
const md = require('../src/content/markdown.js');

/** Flattens a parse tree back to its visible characters. */
function visible(blocks) {
  return blocks.map(function (block) {
    if (block.type === 'code') return block.text;
    if (block.type === 'list') return block.items.map(inlineText).join('\n');
    return inlineText(block.inline);
  }).join('\n');
}

function inlineText(nodes) {
  return nodes.map(function (node) {
    if (node.type === 'text' || node.type === 'code') return node.text;
    if (node.type === 'break') return '\n';
    return inlineText(node.children);
  }).join('');
}

function firstLink(blocks) {
  let found = null;
  (function walk(nodes) {
    for (const node of nodes || []) {
      if (node.type === 'link') found = found || node;
      if (node.children) walk(node.children);
    }
  })(blocks.flatMap(function (b) { return b.inline || []; }));
  return found;
}

// MARK: - Link safety

test('a javascript: target is never a link', () => {
  const blocks = md.parse('see [this](javascript:alert(1)) now');
  assert.strictEqual(firstLink(blocks), null);
  // The characters survive as the text they were, rather than vanishing.
  assert.strictEqual(visible(blocks), 'see [this](javascript:alert(1)) now');
});

test('data: and relative targets are refused too', () => {
  assert.strictEqual(md.safeHref('data:text/html,<script>'), null);
  assert.strictEqual(md.safeHref('/settings/tokens'), null);
  assert.strictEqual(md.safeHref('JaVaScRiPt:alert(1)'), null);
  assert.strictEqual(md.safeHref('  javascript:alert(1)  '), null);
});

test('http, https and mailto are allowed through unchanged', () => {
  assert.strictEqual(md.safeHref('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.strictEqual(md.safeHref('http://example.com'), 'http://example.com');
  assert.strictEqual(md.safeHref('mailto:a@example.com'), 'mailto:a@example.com');
});

test('a bare URL becomes a link', () => {
  const link = firstLink(md.parse('read https://example.com/docs please'));
  assert.strictEqual(link.href, 'https://example.com/docs');
});

// MARK: - Raw HTML is never markup

test('HTML in a reply stays literal text', () => {
  const hostile = '<img src=x onerror=alert(1)> and <b>bold</b>';
  const blocks = md.parse(hostile);
  assert.strictEqual(visible(blocks), hostile);
  assert.strictEqual(blocks.length, 1);
  assert.strictEqual(blocks[0].type, 'paragraph');
});

// MARK: - The subset

test('fenced code keeps its contents verbatim', () => {
  const blocks = md.parse('before\n\n```js\nconst a = **not bold**;\n```\n\nafter');
  assert.deepStrictEqual(blocks.map(b => b.type), ['paragraph', 'code', 'paragraph']);
  assert.strictEqual(blocks[1].text, 'const a = **not bold**;');
});

test('bullet and numbered lists are separate blocks', () => {
  const bullets = md.parse('- first\n- second');
  assert.strictEqual(bullets[0].type, 'list');
  assert.strictEqual(bullets[0].ordered, false);
  assert.strictEqual(bullets[0].items.length, 2);

  const numbered = md.parse('1. first\n2. second');
  assert.strictEqual(numbered[0].ordered, true);
  assert.strictEqual(numbered[0].items.length, 2);
});

test('emphasis, strong and inline code nest and survive', () => {
  const blocks = md.parse('a **bold** and *italic* and `code`');
  const kinds = blocks[0].inline.map(n => n.type);
  assert.ok(kinds.includes('strong'));
  assert.ok(kinds.includes('em'));
  assert.ok(kinds.includes('code'));
  assert.strictEqual(visible(blocks), 'a bold and italic and code');
});

test('a single newline inside a paragraph is a line break', () => {
  const blocks = md.parse('one\ntwo');
  assert.strictEqual(blocks.length, 1);
  assert.ok(blocks[0].inline.some(n => n.type === 'break'));
});

// MARK: - Malformed input

test('unterminated markers degrade to text rather than throwing', () => {
  for (const input of ['**bold', '`code', '[label](https://example.com', '```\nunclosed', '_', '[]()']) {
    assert.doesNotThrow(() => md.parse(input), input);
  }
  assert.strictEqual(visible(md.parse('**bold')), '**bold');
  assert.strictEqual(visible(md.parse('a * b * c')), 'a * b * c');
});

test('empty and nullish input produce no blocks', () => {
  assert.deepStrictEqual(md.parse(''), []);
  assert.deepStrictEqual(md.parse(null), []);
  assert.deepStrictEqual(md.parse('   \n\n  '), []);
});

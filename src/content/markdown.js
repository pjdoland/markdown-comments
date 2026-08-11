/**
 * A small Markdown subset for reply text in the panel.
 *
 * Replies are written as Markdown and stored as Markdown, and until now the
 * panel showed them as flat text while GitHub rendered the same words as real
 * formatting in the footnote. This closes that gap.
 *
 * Parsing and rendering are separate on purpose. `parse` is pure and has no DOM
 * in it, so the risky half is unit testable; `toDOM` builds elements with
 * createElement and textContent and never touches innerHTML, so the extension
 * keeps its property of having no HTML sink anywhere.
 *
 * The subset is deliberately narrow: no images, no raw HTML, no reference
 * links. Anything unrecognised stays literal text, which is the right failure
 * for a comment box. Link targets are checked against a scheme allowlist, so a
 * javascript: or data: URL renders as the characters someone typed.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MDCMarkdown = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const FENCE = /^\s{0,3}(```|~~~)/;
  const BULLET = /^(\s*)([-*+])\s+/;
  const NUMBER = /^(\s*)(\d+)[.)]\s+/;
  const AUTOLINK = /^https?:\/\/[^\s<>()[\]]+/;
  const SAFE_SCHEMES = ['http', 'https', 'mailto'];

  // MARK: - Block level

  function parse(text) {
    const lines = String(text == null ? '' : text).split('\n');
    const blocks = [];
    let i = 0;

    while (i < lines.length) {
      if (!lines[i].trim()) {
        i += 1;
        continue;
      }

      const fence = FENCE.exec(lines[i]);
      if (fence) {
        const marker = fence[1];
        const body = [];
        i += 1;
        while (i < lines.length && lines[i].trim().indexOf(marker) !== 0) {
          body.push(lines[i]);
          i += 1;
        }
        // An unterminated fence runs to the end rather than throwing away the
        // rest of the reply.
        if (i < lines.length) i += 1;
        blocks.push({ type: 'code', text: body.join('\n') });
        continue;
      }

      if (BULLET.test(lines[i]) || NUMBER.test(lines[i])) {
        const ordered = NUMBER.test(lines[i]);
        const items = [];
        while (i < lines.length && isItemOfSameKind(lines[i], ordered)) {
          items.push(parseInline(lines[i].replace(ordered ? NUMBER : BULLET, '')));
          i += 1;
        }
        blocks.push({ type: 'list', ordered: ordered, items: items });
        continue;
      }

      const paragraph = [];
      while (i < lines.length && lines[i].trim() &&
             !FENCE.test(lines[i]) && !BULLET.test(lines[i]) && !NUMBER.test(lines[i])) {
        paragraph.push(lines[i]);
        i += 1;
      }
      blocks.push({ type: 'paragraph', inline: parseInline(paragraph.join('\n')) });
    }

    return blocks;
  }

  function isItemOfSameKind(line, ordered) {
    return ordered ? NUMBER.test(line) : BULLET.test(line);
  }

  // MARK: - Inline level

  function parseInline(text) {
    const nodes = [];
    let buffer = '';
    let i = 0;

    function flush() {
      if (buffer) nodes.push({ type: 'text', text: buffer });
      buffer = '';
    }

    while (i < text.length) {
      const rest = text.slice(i);
      const ch = text[i];

      if (ch === '\n') {
        flush();
        nodes.push({ type: 'break' });
        i += 1;
        continue;
      }

      if (ch === '`') {
        const code = matchCode(rest);
        if (code) {
          flush();
          nodes.push({ type: 'code', text: code.text });
          i += code.length;
          continue;
        }
      }

      if (ch === '[') {
        const link = matchLink(rest);
        if (link) {
          flush();
          nodes.push({ type: 'link', href: link.href, children: parseInline(link.label) });
          i += link.length;
          continue;
        }
      }

      if (ch === 'h') {
        const bare = AUTOLINK.exec(rest);
        if (bare) {
          flush();
          nodes.push({
            type: 'link',
            href: bare[0],
            children: [{ type: 'text', text: bare[0] }]
          });
          i += bare[0].length;
          continue;
        }
      }

      if (ch === '*' || ch === '_') {
        const double = rest.slice(0, 2);
        const emphasis = (double === '**' || double === '__')
          ? matchEmphasis(rest, double, 'strong')
          : matchEmphasis(rest, ch, 'em');
        if (emphasis) {
          flush();
          nodes.push({ type: emphasis.kind, children: parseInline(emphasis.inner) });
          i += emphasis.length;
          continue;
        }
      }

      buffer += ch;
      i += 1;
    }

    flush();
    return nodes;
  }

  /** Inline code, delimited by a run of backticks of matching length. */
  function matchCode(rest) {
    let run = 0;
    while (rest[run] === '`') run += 1;
    const marker = rest.slice(0, run);
    const close = rest.indexOf(marker, run);
    if (close === -1) return null;
    return { text: rest.slice(run, close), length: close + run };
  }

  function matchEmphasis(rest, marker, kind) {
    const close = rest.indexOf(marker, marker.length);
    if (close === -1) return null;
    const inner = rest.slice(marker.length, close);
    // "a * b * c" is arithmetic, not emphasis, and an empty pair is nothing.
    if (!inner.trim() || inner[0] === ' ') return null;
    return { kind: kind, inner: inner, length: close + marker.length };
  }

  /** `[label](target)`, returning null when the target is not one we will link. */
  function matchLink(rest) {
    const labelEnd = matchBracket(rest);
    if (labelEnd === -1 || rest[labelEnd + 1] !== '(') return null;
    const targetEnd = rest.indexOf(')', labelEnd + 2);
    if (targetEnd === -1) return null;

    const href = safeHref(rest.slice(labelEnd + 2, targetEnd));
    if (!href) return null;

    return {
      label: rest.slice(1, labelEnd),
      href: href,
      length: targetEnd + 1
    };
  }

  function matchBracket(text) {
    let depth = 0;
    for (let i = 0; i < text.length; i++) {
      if (text[i] === '\n') return -1;
      if (text[i] === '[') depth += 1;
      else if (text[i] === ']') {
        depth -= 1;
        if (depth === 0) return i;
      }
    }
    return -1;
  }

  /**
   * The link target, or null when it is not one worth rendering as a link.
   *
   * Absolute and allowlisted only. A relative target would resolve against
   * github.com, which is not what the author of a comment meant, and every
   * other scheme (javascript:, data:, and whatever comes next) is exactly the
   * thing this check exists for. Rejected targets do not disappear: the caller
   * leaves the whole `[label](target)` as the literal text it was.
   */
  function safeHref(raw) {
    const value = String(raw == null ? '' : raw).trim();
    const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(value);
    if (!scheme) return null;
    return SAFE_SCHEMES.indexOf(scheme[1].toLowerCase()) === -1 ? null : value;
  }

  // MARK: - Rendering

  /**
   * Builds a DocumentFragment. Every piece of author text lands as textContent
   * or a text node, and the only attribute set is an href already through
   * safeHref, so there is no path from a reply to markup.
   */
  function toDOM(blocks, doc) {
    const owner = doc || document;
    const fragment = owner.createDocumentFragment();

    for (const block of blocks) {
      if (block.type === 'code') {
        const pre = owner.createElement('pre');
        const code = owner.createElement('code');
        code.textContent = block.text;
        pre.appendChild(code);
        fragment.appendChild(pre);
        continue;
      }

      if (block.type === 'list') {
        const list = owner.createElement(block.ordered ? 'ol' : 'ul');
        for (const item of block.items) {
          const li = owner.createElement('li');
          appendInline(item, li, owner);
          list.appendChild(li);
        }
        fragment.appendChild(list);
        continue;
      }

      const paragraph = owner.createElement('p');
      appendInline(block.inline, paragraph, owner);
      fragment.appendChild(paragraph);
    }

    return fragment;
  }

  function appendInline(nodes, parent, owner) {
    for (const node of nodes) {
      if (node.type === 'text') {
        parent.appendChild(owner.createTextNode(node.text));
      } else if (node.type === 'break') {
        parent.appendChild(owner.createElement('br'));
      } else if (node.type === 'code') {
        const code = owner.createElement('code');
        code.textContent = node.text;
        parent.appendChild(code);
      } else if (node.type === 'link') {
        const link = owner.createElement('a');
        link.href = node.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        appendInline(node.children, link, owner);
        parent.appendChild(link);
      } else {
        const wrapper = owner.createElement(node.type === 'strong' ? 'strong' : 'em');
        appendInline(node.children, wrapper, owner);
        parent.appendChild(wrapper);
      }
    }
  }

  function render(text, doc) {
    return toDOM(parse(text), doc);
  }

  return {
    parse: parse,
    toDOM: toDOM,
    render: render,
    safeHref: safeHref
  };
});

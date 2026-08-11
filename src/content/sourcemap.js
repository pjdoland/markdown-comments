/**
 * Mapping a selection in GitHub's rendered HTML back to an offset in the raw
 * markdown, so a new anchor pair can be inserted at the right place.
 *
 * GitHub publishes no source map for rendered markdown, so this projects the
 * source down to approximate rendered text while remembering where each
 * character came from, then looks the selection up in that projection. The
 * projection only has to be good enough to *locate* a phrase, not to render it.
 *
 * Every result is verified before use, and an unverifiable match is refused
 * rather than guessed at. Anchoring the wrong span would be worse than
 * declining to anchor at all.
 */
const RNSourceMap = (function () {
  'use strict';

  function normalize(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Projects markdown to plain text with an index back to source offsets.
   * Whitespace is collapsed exactly as RNAnchor.buildTextIndex collapses it in
   * the DOM, so the two strings are directly comparable.
   */
  function project(source) {
    const chars = [];
    const map = [];
    let pendingSpace = true;
    let atLineStart = true;
    let i = 0;
    const n = source.length;
    let inFence = false;

    function push(ch, at) {
      if (ch === ' ') {
        if (pendingSpace) return;
        chars.push(' ');
        map.push(at);
        pendingSpace = true;
      } else {
        chars.push(ch);
        map.push(at);
        pendingSpace = false;
      }
    }

    function restOfLine(from) {
      const nl = source.indexOf('\n', from);
      return nl === -1 ? n : nl;
    }

    while (i < n) {
      if (atLineStart) {
        atLineStart = false;
        const lineEnd = restOfLine(i);
        const line = source.slice(i, lineEnd);

        // Fence open/close: the marker line contributes nothing.
        if (/^\s{0,3}(```|~~~)/.test(line)) {
          inFence = !inFence;
          i = lineEnd;
          continue;
        }
        if (!inFence) {
          // Horizontal rules and table separator rows render as no text.
          if (/^\s{0,3}([-*_])(\s*\1){2,}\s*$/.test(line) || /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(line)) {
            i = lineEnd;
            continue;
          }
          // Block prefixes: indentation, blockquotes, list markers, task
          // boxes and heading hashes all render as structure, not text.
          const prefix = /^[ \t]*(?:>[ \t]?)*[ \t]*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:\[[ xX]\][ \t]+)?(?:#{1,6}[ \t]+)?/.exec(line);
          if (prefix && prefix[0]) i += prefix[0].length;
          // A leading table pipe is a cell boundary.
          if (source[i] === '|') i += 1;
        }
        if (i >= n) break;
      }

      const ch = source[i];

      if (ch === '\n') {
        push(' ', i);
        i += 1;
        atLineStart = true;
        continue;
      }

      if (inFence) {
        push(ch, i);
        i += 1;
        continue;
      }

      // Our own anchor markers, and any other HTML comment.
      if (source.startsWith('<!--', i)) {
        const close = source.indexOf('-->', i);
        i = close === -1 ? n : close + 3;
        continue;
      }
      // Footnote references contribute a superscript number, which the DOM
      // index skips too.
      if (ch === '[' && source[i + 1] === '^') {
        const close = source.indexOf(']', i);
        if (close !== -1) {
          i = close + 1;
          continue;
        }
      }
      // Images render as an element with no text.
      if (ch === '!' && source[i + 1] === '[') {
        const closed = matchBracket(source, i + 1);
        if (closed !== -1) {
          i = skipLinkTarget(source, closed + 1);
          continue;
        }
      }
      // Links keep their label and drop the target.
      if (ch === '[') {
        const closed = matchBracket(source, i);
        if (closed !== -1) {
          for (let k = i + 1; k < closed; k++) push(source[k], k);
          i = skipLinkTarget(source, closed + 1);
          continue;
        }
      }
      if (ch === '\\' && i + 1 < n) {
        push(source[i + 1], i + 1);
        i += 2;
        continue;
      }
      if (ch === '`') {
        let run = 0;
        while (source[i + run] === '`') run += 1;
        i += run;
        continue;
      }
      if (source.startsWith('**', i) || source.startsWith('__', i) || source.startsWith('~~', i)) {
        i += 2;
        continue;
      }
      if (ch === '*' || ch === '_') {
        i += 1;
        continue;
      }
      if (ch === '<') {
        const close = source.indexOf('>', i);
        // Only treat it as a tag if it looks like one; otherwise it is text.
        if (close !== -1 && /^<\/?[a-zA-Z][^>]*>$/.test(source.slice(i, close + 1))) {
          i = close + 1;
          continue;
        }
      }
      if (ch === '|') {
        // Table cell boundary renders as separation, not a character.
        push(' ', i);
        i += 1;
        continue;
      }

      push(ch, i);
      i += 1;
    }

    while (chars.length && chars[chars.length - 1] === ' ') {
      chars.pop();
      map.pop();
    }
    return { text: chars.join(''), map: map };
  }

  function matchBracket(source, openIndex) {
    let depth = 0;
    for (let i = openIndex; i < source.length; i++) {
      if (source[i] === '\\') { i += 1; continue; }
      if (source[i] === '[') depth += 1;
      else if (source[i] === ']') {
        depth -= 1;
        if (depth === 0) return i;
      } else if (source[i] === '\n' && source[i + 1] === '\n') return -1;
    }
    return -1;
  }

  /** Skips `(url)` or `[ref]` immediately following a link label. */
  function skipLinkTarget(source, index) {
    if (source[index] === '(') {
      let depth = 0;
      for (let i = index; i < source.length; i++) {
        if (source[i] === '(') depth += 1;
        else if (source[i] === ')') {
          depth -= 1;
          if (depth === 0) return i + 1;
        } else if (source[i] === '\n') break;
      }
      return index;
    }
    if (source[index] === '[') {
      const close = source.indexOf(']', index);
      if (close !== -1) return close + 1;
    }
    return index;
  }

  /** The [start, end) span of every complete anchor pair in the source. */
  function anchorRegions(source) {
    const regions = [];
    const open = new Map();
    for (const match of source.matchAll(/<!--(\/?)rn:([0-9a-f]{8})-->/g)) {
      const id = match[2];
      if (match[1] !== '/') {
        if (!open.has(id)) open.set(id, match.index);
      } else if (open.has(id)) {
        regions.push([open.get(id), match.index + match[0].length]);
        open.delete(id);
      }
    }
    return regions;
  }

  function overlapsAnchor(source, start, end) {
    return anchorRegions(source).some(function (region) {
      return start < region[1] && end > region[0];
    });
  }

  /**
   * How many earlier occurrences of the same text appear in the rendered body,
   * so an ambiguous phrase resolves to the one the reader actually selected.
   */
  function selectionOrdinal(root, range, needle) {
    const target = normalize(needle);
    if (!target) return 0;
    const index = RNAnchor.buildTextIndex(root, null);

    let startOffset = -1;
    for (let i = 0; i < index.positions.length; i++) {
      const position = index.positions[i];
      if (position.node === range.startContainer && position.offset >= range.startOffset) {
        startOffset = i;
        break;
      }
    }
    if (startOffset === -1) return 0;

    let count = 0;
    let from = 0;
    for (;;) {
      const at = index.text.indexOf(target, from);
      if (at === -1 || at >= startOffset) break;
      count += 1;
      from = at + 1;
    }
    return count;
  }

  /**
   * Resolves rendered text to a [start, end) span of the raw markdown.
   * Returns { start, end } or { error } explaining why it could not.
   */
  function findSourceSpan(source, selectedText, ordinal) {
    const target = normalize(selectedText);
    if (!target) return { error: 'Nothing selected.' };

    const projection = project(source);
    const occurrences = [];
    let from = 0;
    for (;;) {
      const at = projection.text.indexOf(target, from);
      if (at === -1) break;
      occurrences.push(at);
      from = at + 1;
    }

    if (!occurrences.length) {
      return {
        error: 'Could not find that text in the source. Selections that span ' +
               'images, emoji shortcodes or HTML may not match.'
      };
    }

    const chosen = occurrences[Math.min(ordinal || 0, occurrences.length - 1)];
    const start = projection.map[chosen];
    const endChar = projection.map[chosen + target.length - 1];
    if (start == null || endChar == null) return { error: 'Could not map the selection to the source.' };
    const end = endChar + 1;

    // Refuse rather than guess. Anchors cannot nest or partially overlap: the
    // rich editor skips text already inside a comment span, so the inner
    // markers would be dropped the next time the file was saved from there.
    const slice = source.slice(start, end);
    if (slice.includes('<!--') || slice.includes('-->') || overlapsAnchor(source, start, end)) {
      return { error: 'That selection overlaps an existing comment. Comments cannot be nested.' };
    }
    if (!slice.trim()) return { error: 'Could not map the selection to the source.' };

    return { start: start, end: end, ambiguous: occurrences.length > 1 };
  }

  return {
    project: project,
    selectionOrdinal: selectionOrdinal,
    findSourceSpan: findSourceSpan,
    normalize: normalize
  };
})();

if (typeof module === 'object' && module.exports) module.exports = RNSourceMap;

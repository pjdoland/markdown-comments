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
const MDCSourceMap = (function () {
  'use strict';

  function normalize(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Projects markdown to plain text with an index back to source offsets.
   * Whitespace is collapsed exactly as MDCAnchor.buildTextIndex collapses it in
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
    for (const match of source.matchAll(/<!--(\/?)mdc:([0-9a-f]{8})-->/g)) {
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
    const index = MDCAnchor.buildTextIndex(root, null);

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

  // MARK: - Recovering an orphan

  const FUZZY_SCORE = 0.7;   // below this it is a different sentence
  const FUZZY_MARGIN = 0.15; // and it has to beat the runner-up by this much

  function words(text) {
    const found = [];
    for (const match of String(text || '').matchAll(/[A-Za-z0-9]+/g)) {
      found.push({ word: match[0].toLowerCase(), start: match.index, end: match.index + match[0].length });
    }
    return found;
  }

  /** How much of two word lists is shared, counting repeats. */
  function overlap(a, b) {
    const counts = new Map();
    for (const word of a) counts.set(word, (counts.get(word) || 0) + 1);
    let shared = 0;
    for (const word of b) {
      const left = counts.get(word) || 0;
      if (left > 0) {
        counts.set(word, left - 1);
        shared += 1;
      }
    }
    return shared / Math.max(a.length, b.length);
  }

  /** How many words sit at the same offset in both lists. */
  function alignment(a, b) {
    let same = 0;
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      if (a[i] === b[i]) same += 1;
    }
    return same;
  }

  // Markup the candidate must not cut through. An anchor pair written across
  // half an emphasis run or a link would rewrite the prose as well as annotate
  // it, so a passage carrying any of this is left for a person to select.
  const MARKUP = /[`*_[\]<>|]/;

  /**
   * Where an orphaned thread's text seems to have gone, or null.
   *
   * A thread is orphaned when its anchor markers are no longer in the file,
   * which usually means the sentence was edited rather than deleted. This finds
   * the passage that still reads like it, so the thread can be offered back its
   * place instead of sitting at the bottom of the document forever.
   *
   * It is deliberately hard to satisfy. The match has to be good in absolute
   * terms and clearly better than the next candidate, because the cost of being
   * wrong is a comment silently pointing at the wrong words, which is the
   * failure this whole module is written to avoid. The caller confirms before
   * anything is written.
   */
  function findFuzzySpan(source, target) {
    const wanted = words(normalize(target));
    // One word is a coincidence, not a match.
    if (wanted.length < 2) return null;

    const projection = project(source);
    const haystack = words(projection.text);
    if (!haystack.length) return null;

    const wantedWords = wanted.map(function (w) { return w.word; });
    const shortest = Math.max(2, wanted.length - 2);
    const longest = wanted.length + 2;

    const windows = [];
    for (let i = 0; i < haystack.length; i++) {
      for (let n = shortest; n <= longest && i + n <= haystack.length; n++) {
        const span = haystack.slice(i, i + n);
        const found = span.map(function (w) { return w.word; });
        windows.push({
          score: overlap(wantedWords, found),
          // Two windows can share a score while one of them starts a word early.
          // Words landing at the same offset as in the original break that tie.
          aligned: alignment(wantedWords, found),
          first: i,
          last: i + n - 1,
          from: span[0].start,
          to: span[n - 1].end
        });
      }
    }
    if (!windows.length) return null;

    windows.sort(function (a, b) {
      return (b.score - a.score) || (b.aligned - a.aligned) || (a.first - b.first);
    });
    const best = windows[0];

    // The rival is the best window somewhere else in the document. Overlapping
    // windows are the same passage measured twice, not a second candidate.
    let runnerUp = 0;
    for (const window of windows) {
      if (window.first > best.last || window.last < best.first) {
        runnerUp = window.score;
        break;
      }
    }

    if (best.score < FUZZY_SCORE || best.score - runnerUp < FUZZY_MARGIN) return null;

    const start = projection.map[best.from];
    const endChar = projection.map[best.to - 1];
    if (start == null || endChar == null) return null;
    const end = endChar + 1;

    // Same refusals as a fresh anchor: comments cannot nest, and markers in the
    // slice would be swallowed by the pair we are about to write around it.
    const slice = source.slice(start, end);
    if (!slice.trim()) return null;
    if (MARKUP.test(slice)) return null;
    if (overlapsAnchor(source, start, end)) return null;

    return {
      start: start,
      end: end,
      score: best.score,
      text: projection.text.slice(best.from, best.to)
    };
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
    findFuzzySpan: findFuzzySpan,
    normalize: normalize
  };
})();

if (typeof module === 'object' && module.exports) module.exports = MDCSourceMap;

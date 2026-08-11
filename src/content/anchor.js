/**
 * Locating comment ranges inside GitHub's rendered markdown.
 *
 * GitHub strips HTML comments from its output, so the anchor markers that
 * delimit a range in the source are invisible here. What survives is the
 * footnote reference, and it sits at exactly the end of the anchored range.
 * So the range is recovered by walking backwards from the reference by the
 * length of the stored anchor text, which is unambiguous even when the same
 * phrase appears elsewhere in the document.
 *
 * Highlighting uses the CSS Custom Highlight API rather than wrapping text in
 * spans. GitHub's blob view is a React tree, and injected elements inside it
 * get clobbered on re-render. Highlights live outside the DOM entirely.
 */
const MDCAnchor = (function () {
  'use strict';

  function normalizeWhitespace(value) {
    return String(value == null ? '' : value).replace(/\s+/g, ' ').trim();
  }

  /**
   * Text that is in the DOM but not in the markdown prose: footnote reference
   * numbers, the footnote section itself, and anything we injected.
   */
  function isSkippable(node) {
    let el = node.parentElement;
    while (el) {
      if (el.matches('[data-footnote-ref], .footnotes, [data-mdc-ui], .anchor')) return true;
      if (el.classList && el.classList.contains('markdown-body')) return false;
      el = el.parentElement;
    }
    return false;
  }

  /**
   * The elements GitHub rendered for the codec's unanchored block, or an empty
   * list when the document has none.
   *
   * The block renders as ordinary markdown with no marker of its own, so it is
   * recognised by the exact shape the codec emits: a top-level bold-only
   * paragraph reading "Unanchored comments", immediately followed by the list
   * of orphans. Both parts are required, and the paragraph must be a direct
   * child of the rendered body, so prose that merely quotes the phrase does not
   * match. The last such pair wins, since ours is written after the document.
   *
   * Nothing beyond those two elements is ours. GitHub's footnote section
   * follows them, and so does anything a person typed below the region, and
   * neither may be swept up.
   */
  function generatedElements(root) {
    let found = [];
    for (const strong of root.querySelectorAll(':scope > p > strong:only-child')) {
      if (strong.textContent.trim() !== 'Unanchored comments') continue;
      const paragraph = strong.parentElement;
      const list = paragraph.nextElementSibling;
      if (!list || list.tagName !== 'UL') continue;
      found = [paragraph, list];
    }
    return found;
  }

  /**
   * Where the generated region starts. Its text renders as ordinary markdown,
   * so it would otherwise be indistinguishable from prose in the index.
   */
  function regionBoundary(root) {
    const generated = generatedElements(root);
    return generated.length ? generated[0] : null;
  }

  /**
   * Builds a whitespace-normalized string over the text nodes of `root`,
   * stopping before `stopEl`, keeping an index from each character back to its
   * (node, offset) so a match can be turned into a DOM Range.
   */
  function buildTextIndex(root, stopEl, startEl) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
    const boundary = regionBoundary(root);
    let text = '';
    const positions = [];
    let pendingSpace = true; // also suppresses leading whitespace
    let started = !startEl;

    while (walker.nextNode()) {
      const node = walker.currentNode;
      if (!started) {
        // Skip everything up to and including startEl.
        if (startEl.contains(node)) continue;
        if (!(startEl.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
        started = true;
      }
      if (boundary) {
        if (boundary.contains(node)) break;
        if (boundary.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      }
      if (stopEl) {
        if (stopEl.contains(node)) break;
        if (stopEl.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) break;
      }
      if (isSkippable(node)) continue;

      const raw = node.nodeValue;
      for (let i = 0; i < raw.length; i++) {
        const ch = raw[i];
        if (ch === ' ' || ch === '\n' || ch === '\t' || ch === '\r' || ch === ' ') {
          if (pendingSpace) continue;
          text += ' ';
          positions.push({ node: node, offset: i });
          pendingSpace = true;
        } else {
          text += ch;
          positions.push({ node: node, offset: i });
          pendingSpace = false;
        }
      }
    }

    while (text.endsWith(' ')) {
      text = text.slice(0, -1);
      positions.pop();
    }
    return { text: text, positions: positions };
  }

  /** The footnote reference element GitHub rendered for a thread, if present. */
  function referenceFor(root, id) {
    const ref = root.querySelector('[id^="user-content-fnref-mdc-' + id + '"]');
    if (!ref) return null;
    return ref.closest('sup') || ref;
  }

  /**
   * Resolves a thread to a DOM Range over its anchored text.
   * Returns null when the reference or the text cannot be found.
   */
  function locate(root, thread) {
    if (!/^[0-9a-f]{8}$/.test(thread.id)) return null;
    const target = normalizeWhitespace(thread.anchor);
    if (!target) return null;

    const marker = referenceFor(root, thread.id);
    if (!marker) {
      // The page was rendered before this comment existed, so there is no
      // reference to walk from. Fall back to the anchor text, but only when it
      // appears exactly once: a wrong highlight is worse than none.
      return locateUnique(root, target);
    }

    // Usually the reference trails the anchored phrase. For a phrase that
    // starts a block the codec puts the reference in front of it instead, so
    // both directions have to be considered.
    const before = buildTextIndex(root, marker, null);
    if (before.text.endsWith(target)) {
      return rangeFrom(before, before.text.length - target.length, target.length);
    }

    const after = buildTextIndex(root, null, marker);
    if (after.text.startsWith(target)) {
      return rangeFrom(after, 0, target.length);
    }

    // Punctuation or an inline element may sit between the phrase and its
    // marker; fall back to the nearest occurrence before it.
    const fallback = before.text.lastIndexOf(target);
    if (fallback !== -1) return rangeFrom(before, fallback, target.length);

    return null;
  }

  /**
   * Tags the generated "Unanchored comments" block so CSS can hide it. Unlike
   * the footnotes it renders as ordinary Markdown with nothing to select on.
   *
   * Elements already carrying the class are left untouched rather than cleared
   * and re-added: this runs on every refresh, and rewriting the class would
   * invalidate style across the document each time for an identical result.
   */
  function markGeneratedRegion(root) {
    const generated = generatedElements(root);
    for (const tagged of root.querySelectorAll('.mdc-generated')) {
      if (generated.indexOf(tagged) === -1) tagged.classList.remove('mdc-generated');
    }
    for (const element of generated) element.classList.add('mdc-generated');
  }

  /** Matches anchor text only when there is exactly one candidate. */
  function locateUnique(root, target) {
    const index = buildTextIndex(root, null, null);
    const first = index.text.indexOf(target);
    if (first === -1) return null;
    if (index.text.indexOf(target, first + 1) !== -1) return null;
    return rangeFrom(index, first, target.length);
  }

  function rangeFrom(index, start, length) {
    const first = index.positions[start];
    const last = index.positions[start + length - 1];
    if (!first || !last) return null;
    try {
      const range = document.createRange();
      range.setStart(first.node, first.offset);
      range.setEnd(last.node, last.offset + 1);
      return range;
    } catch (e) {
      return null;
    }
  }

  /**
   * The prose a range covers, as the source spells it.
   *
   * Range.toString() concatenates every text node between its endpoints,
   * including the footnote reference superscripts, and those digits appear
   * nowhere in the markdown. They are invisible while the panel is open, so a
   * selection that crosses one looks perfectly ordinary on screen; dropping
   * them here is what keeps it matchable against the source.
   */
  function rangeText(range) {
    const fragment = range.cloneContents();
    for (const el of fragment.querySelectorAll('[data-footnote-ref], .footnotes, [data-mdc-ui], .anchor')) {
      el.remove();
    }
    return normalizeWhitespace(fragment.textContent);
  }

  // MARK: - Highlighting

  const supportsHighlights =
    typeof Highlight !== 'undefined' && typeof CSS !== 'undefined' && !!CSS.highlights;

  function setHighlight(name, ranges) {
    if (!supportsHighlights) return;
    if (!ranges.length) {
      CSS.highlights.delete(name);
      return;
    }
    CSS.highlights.set(name, new Highlight(...ranges));
  }

  function applyHighlights(entries, activeID) {
    if (!supportsHighlights) return false;
    const open = [];
    const resolved = [];
    const active = [];
    for (const entry of entries) {
      if (!entry.range) continue;
      if (entry.id === activeID) active.push(entry.range);
      else if (entry.thread.status === 'resolved') resolved.push(entry.range);
      else open.push(entry.range);
    }
    setHighlight('mdc-comment', open);
    setHighlight('mdc-comment-resolved', resolved);
    setHighlight('mdc-comment-active', active);
    return true;
  }

  function clearHighlights() {
    if (!supportsHighlights) return;
    CSS.highlights.delete('mdc-comment');
    CSS.highlights.delete('mdc-comment-resolved');
    CSS.highlights.delete('mdc-comment-active');
  }

  // MARK: - Hit testing

  function caretRangeFromPoint(x, y) {
    if (document.caretRangeFromPoint) return document.caretRangeFromPoint(x, y);
    if (document.caretPositionFromPoint) {
      const position = document.caretPositionFromPoint(x, y);
      if (!position) return null;
      const range = document.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
    return null;
  }

  /**
   * Which thread, if any, is under the pointer. Highlights are not elements,
   * so this resolves the caret position and tests it against known ranges.
   */
  function threadAtPoint(entries, x, y) {
    const caret = caretRangeFromPoint(x, y);
    if (!caret) return null;
    for (const entry of entries) {
      if (!entry.range) continue;
      try {
        if (entry.range.comparePoint(caret.startContainer, caret.startOffset) === 0) {
          return entry.id;
        }
      } catch (e) {
        // Node lives in another tree; not a match.
      }
    }
    return null;
  }

  function scrollTo(entry) {
    if (!entry || !entry.range) return;
    const rect = entry.range.getBoundingClientRect();
    if (!rect.height && !rect.width) return;
    const target = window.scrollY + rect.top - window.innerHeight / 2;
    window.scrollTo({ top: Math.max(0, target), behavior: 'smooth' });
  }

  return {
    normalizeWhitespace: normalizeWhitespace,
    buildTextIndex: buildTextIndex,
    locate: locate,
    rangeText: rangeText,
    applyHighlights: applyHighlights,
    clearHighlights: clearHighlights,
    threadAtPoint: threadAtPoint,
    scrollTo: scrollTo,
    markGeneratedRegion: markGeneratedRegion,
    supportsHighlights: supportsHighlights
  };
})();

if (typeof module === 'object' && module.exports) module.exports = MDCAnchor;

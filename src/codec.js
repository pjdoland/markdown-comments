/**
 * Reads and writes the on-disk representation of document comments.
 *
 * Output is deterministic, because the whole region is regenerated on every
 * save and lands in a commit. Anything that varies by machine or by viewer
 * would rewrite lines nobody edited:
 *
 *   - JSON keys are emitted in sorted order
 *   - timestamps are seconds-precision ISO 8601, no milliseconds
 *   - display dates are en-US in UTC, never the viewer's locale
 *   - every ">" in the JSON is escaped so the block cannot contain "-->"
 *   - one thread per line, so two branches adding comments conflict on their
 *     own lines rather than on the whole block
 *
 * The data block carries a version. Readers accept the current shape and the
 * unversioned array that preceded it; writers only ever emit the current one.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.MDCCodec = api;
})(typeof self !== 'undefined' ? self : globalThis, function () {
  'use strict';

  const BEGIN_SENTINEL = '<!-- mdc-comments-begin -->';
  const END_SENTINEL = '<!-- mdc-comments-end -->';
  const DATA_OPEN = '<!-- mdc-comments-data';

  // Bumped when the shape of the data block changes in a way a previous reader
  // would misread. Version 0 is the original bare array, still accepted on read.
  const FORMAT_VERSION = 1;

  // MARK: - Reading

  /**
   * Separates a document body into the editable text and its comment threads.
   * The returned body keeps its inline anchor pairs but has the generated
   * region and all footnote references removed.
   */
  function split(body) {
    const beginIndex = body.indexOf(BEGIN_SENTINEL);
    if (beginIndex === -1) return { body: body, threads: [] };
    const endIndex = body.indexOf(END_SENTINEL, beginIndex + BEGIN_SENTINEL.length);
    if (endIndex === -1) return { body: body, threads: [] };

    const region = body.slice(beginIndex, endIndex + END_SENTINEL.length);
    const before = body.slice(0, beginIndex);
    const after = body.slice(endIndex + END_SENTINEL.length);

    let clean = trimTrailingBlanks(before);
    // Anything a person typed below the region would otherwise be lost.
    const trailing = after.trim();
    if (trailing) clean = clean ? clean + '\n\n' + trailing : trailing;
    clean = stripFootnoteRefs(clean);

    const threads = decodeThreads(region);
    const present = anchorIDs(clean);
    for (const thread of threads) thread.isOrphaned = !present.has(thread.id);

    return { body: clean, threads: threads };
  }

  /** The ids of every complete anchor pair in a body. */
  function anchorIDs(body) {
    const opens = capturedIDs(body, /<!--mdc:([0-9a-f]{8})-->/g);
    const closes = capturedIDs(body, /<!--\/mdc:([0-9a-f]{8})-->/g);
    const both = new Set();
    for (const id of opens) if (closes.has(id)) both.add(id);
    return both;
  }

  /** The ids of every complete anchor pair, ordered by first appearance. */
  function orderedAnchorIDs(body) {
    const complete = anchorIDs(body);
    const seen = new Set();
    const ordered = [];
    for (const match of body.matchAll(/<!--mdc:([0-9a-f]{8})-->/g)) {
      const id = match[1];
      if (complete.has(id) && !seen.has(id)) {
        seen.add(id);
        ordered.push(id);
      }
    }
    return ordered;
  }

  // MARK: - Writing

  /**
   * Rebuilds a full document body from editable text plus threads.
   * Self-healing: stale anchors are dropped, adjacent pairs for one thread are
   * merged, and footnote references are regenerated so the reference set always
   * matches the definition set.
   */
  function join(body, threads) {
    const known = new Set(threads.map(t => t.id));
    let text = stripFootnoteRefs(body);
    text = collapseAnchorSeams(text);
    text = dropAnchorsNotIn(text, known);

    if (!threads.length) return text;

    const anchored = anchorIDs(text);
    text = insertFootnoteRefs(text, anchored);

    const lines = [BEGIN_SENTINEL, DATA_OPEN, encodeThreads(threads), '-->'];
    for (const thread of threads) {
      if (!anchored.has(thread.id)) continue;
      lines.push('');
      lines.push.apply(lines, footnoteLines(thread));
    }
    const orphans = threads.filter(t => !anchored.has(t.id));
    if (orphans.length) {
      lines.push('');
      lines.push.apply(lines, unanchoredLines(orphans));
    }
    lines.push('');
    lines.push(END_SENTINEL);

    return trimTrailingBlanks(text) + '\n\n' + lines.join('\n') + '\n';
  }

  function anchorMarkers(id) {
    return { open: '<!--mdc:' + id + '-->', close: '<!--/mdc:' + id + '-->' };
  }

  /** Wraps [start, end) of a raw markdown body in a new anchor pair. */
  function insertAnchor(body, id, start, end) {
    const markers = anchorMarkers(id);
    return body.slice(0, start) + markers.open + body.slice(start, end) +
           markers.close + body.slice(end);
  }

  function newID() {
    const bytes = new Uint8Array(4);
    (globalThis.crypto || {}).getRandomValues
      ? globalThis.crypto.getRandomValues(bytes)
      : bytes.forEach((_, i) => (bytes[i] = Math.floor(Math.random() * 256)));
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
  }

  // MARK: - Visible layer

  function footnoteLines(thread) {
    const lines = ['[^mdc-' + thread.id + ']:'];
    (thread.replies || []).forEach(function (reply, index) {
      if (index > 0) lines.push('');
      const marker = index === 0 && thread.status === 'resolved' ? '_(resolved)_ ' : '';
      const head = marker + '**@' + reply.author + '** · ' + displayDate(reply.date) + ': ';
      const body = escapeForVisibleLayer(reply.text).split('\n');
      lines.push('    ' + head + (body[0] || ''));
      for (const extra of body.slice(1)) lines.push(extra === '' ? '' : '    ' + extra);
    });
    return lines;
  }

  function unanchoredLines(threads) {
    const lines = ['**Unanchored comments**', ''];
    for (const thread of threads) {
      const anchor = escapeForVisibleLayer(thread.anchor).replace(/\n/g, ' ');
      lines.push('- on "' + anchor + '":');
      for (const reply of thread.replies || []) {
        const text = escapeForVisibleLayer(reply.text).replace(/\n/g, ' ');
        lines.push('    - **@' + reply.author + '** · ' + displayDate(reply.date) + ': ' + text);
      }
    }
    return lines;
  }

  /** Neutralizes comment delimiters so reply text cannot forge a sentinel. */
  function escapeForVisibleLayer(text) {
    return String(text == null ? '' : text)
      .trim()
      .split('<!--').join('&lt;!--')
      .split('-->').join('--&gt;');
  }

  // MARK: - JSON layer

  function encodeThreads(threads) {
    // Key order here is alphabetical on purpose: same input, same bytes.
    const lines = threads.map(function (thread) {
      const wire = {
        anchor: thread.anchor,
        id: thread.id,
        replies: (thread.replies || []).map(function (reply) {
          return { at: isoSeconds(reply.date), by: reply.author, text: reply.text };
        }),
        status: thread.status || 'open'
      };
      // The JSON sits inside an HTML comment, so it must not contain "-->".
      // ">" only ever appears inside string values, and > is an equivalent
      // JSON escape, so replacing it wholesale is safe.
      return JSON.stringify(wire).replace(/>/g, '\\u003e');
    });
    // Still one JSON document, just laid out so a thread is a line. Editing one
    // comment then touches one line of the diff.
    return '{"v":' + FORMAT_VERSION + ',"threads":[\n' + lines.join(',\n') + '\n]}';
  }

  function decodeThreads(region) {
    const openIndex = region.indexOf(DATA_OPEN);
    if (openIndex === -1) return [];
    const closeIndex = region.indexOf('-->', openIndex + DATA_OPEN.length);
    if (closeIndex === -1) return [];

    let wire;
    try {
      wire = JSON.parse(region.slice(openIndex + DATA_OPEN.length, closeIndex));
    } catch (e) {
      return [];
    }
    // Version 1 wraps the threads in an object. Version 0 was the bare array,
    // and documents written then still have to open.
    const list = Array.isArray(wire) ? wire
      : (wire && Array.isArray(wire.threads) ? wire.threads : null);
    if (!list) return [];

    return list.map(function (thread) {
      return {
        id: String(thread.id || ''),
        status: thread.status === 'resolved' ? 'resolved' : 'open',
        anchor: String(thread.anchor || ''),
        replies: (thread.replies || []).map(function (reply) {
          const parsed = new Date(reply.at);
          return {
            author: String(reply.by || ''),
            date: isNaN(parsed.getTime()) ? new Date(0) : parsed,
            text: String(reply.text || '')
          };
        }),
        isOrphaned: false
      };
    }).filter(t => /^[0-9a-f]{8}$/.test(t.id));
  }

  // MARK: - Anchor and reference plumbing

  function stripFootnoteRefs(body) {
    return body.replace(/\[\^mdc-[0-9a-f]{8}\]/g, '');
  }

  function collapseAnchorSeams(body) {
    return body.replace(/<!--\/mdc:([0-9a-f]{8})--><!--mdc:\1-->/g, '');
  }

  function dropAnchorsNotIn(body, known) {
    return body.replace(/<!--\/?mdc:([0-9a-f]{8})-->/g, function (match, id) {
      return known.has(id) ? match : '';
    });
  }

  const BLOCK_PREFIX_ONLY = /^[ \t]*(?:>[ \t]*)*(?:(?:[-*+]|\d+[.)])[ \t]+)?(?:#{1,6}[ \t]+)?$/;

  /**
   * True when only block structure (indentation, blockquote arrows, list
   * bullets, heading hashes) separates `offset` from the start of its line.
   */
  function startsBlock(body, offset) {
    const lineStart = body.lastIndexOf('\n', offset - 1) + 1;
    return BLOCK_PREFIX_ONLY.test(body.slice(lineStart, offset));
  }

  /**
   * Puts a reference next to each thread's anchor.
   *
   * Normally it follows the closing marker, so the superscript trails the
   * commented phrase. When the opening marker is the first thing on its line
   * the reference goes before it instead: in CommonMark a line beginning with
   * "<!--" starts an HTML block, which swallows the rest of the line, strips
   * the markers, and leaves "[^mdc-ID]" rendered as literal text on GitHub.
   * Leading with "[" keeps the line ordinary markdown.
   */
  function insertFootnoteRefs(body, ids) {
    const blockInitial = new Map(); // id -> [offset]
    const seen = new Set();
    for (const match of body.matchAll(/<!--mdc:([0-9a-f]{8})-->/g)) {
      const id = match[1];
      if (!ids.has(id)) continue;
      seen.add(id);
      if (!startsBlock(body, match.index)) continue;
      if (!blockInitial.has(id)) blockInitial.set(id, []);
      blockInitial.get(id).push(match.index);
    }
    const lastEnd = new Map();
    for (const match of body.matchAll(/<!--\/mdc:([0-9a-f]{8})-->/g)) {
      if (!ids.has(match[1])) continue;
      lastEnd.set(match[1], match.index + match[0].length);
    }

    const insertions = [];
    for (const id of seen) {
      const starts = blockInitial.get(id);
      if (starts && starts.length) {
        // Every such marker would open an HTML block, so each needs a
        // reference in front of it. GFM allows one footnote to be referenced
        // more than once and renders a backlink per reference.
        for (const offset of starts) insertions.push([offset, '[^mdc-' + id + ']']);
      } else if (lastEnd.has(id)) {
        insertions.push([lastEnd.get(id), '[^mdc-' + id + ']']);
      }
    }
    if (!insertions.length) return body;

    let out = body;
    insertions.sort((a, b) => b[0] - a[0]);
    for (const insertion of insertions) {
      out = out.slice(0, insertion[0]) + insertion[1] + out.slice(insertion[0]);
    }
    return out;
  }

  function capturedIDs(body, pattern) {
    const ids = new Set();
    for (const match of body.matchAll(pattern)) ids.add(match[1]);
    return ids;
  }

  function trimTrailingBlanks(text) {
    let end = text.length;
    while (end > 0) {
      const ch = text[end - 1];
      if (ch === '\n' || ch === '\r' || ch === ' ' || ch === '\t') end--;
      else break;
    }
    return text.slice(0, end);
  }

  // MARK: - Formatting

  /** Seconds precision, matching Swift's ISO8601 .withInternetDateTime. */
  function isoSeconds(date) {
    const d = date instanceof Date ? date : new Date(date);
    return d.toISOString().replace(/\.\d{3}Z$/, 'Z');
  }

  const DISPLAY_FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric'
  });

  /**
   * Fixed locale and time zone on purpose. A locale-dependent date would make
   * every save rewrite every comment line for a viewer in another region.
   */
  function displayDate(date) {
    const d = date instanceof Date ? date : new Date(date);
    return DISPLAY_FORMAT.format(d);
  }

  return {
    BEGIN_SENTINEL: BEGIN_SENTINEL,
    END_SENTINEL: END_SENTINEL,
    FORMAT_VERSION: FORMAT_VERSION,
    split: split,
    join: join,
    anchorIDs: anchorIDs,
    orderedAnchorIDs: orderedAnchorIDs,
    anchorMarkers: anchorMarkers,
    insertAnchor: insertAnchor,
    newID: newID,
    displayDate: displayDate
  };
});

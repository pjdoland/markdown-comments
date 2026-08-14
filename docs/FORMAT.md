# Markdown Comments: file format specification

**Version 1.** Status: stable. This document specifies how comment threads are
stored inside a Markdown file, precisely enough to write an independent
implementation that can read and write the same documents.

The reference implementation is [`src/codec.js`](../src/codec.js). Where this
document and that file disagree, the file is right and this document is a bug.

## 1. Conventions

**MUST**, **MUST NOT**, **SHOULD**, and **MAY** are used in the sense of
RFC 2119. Byte sequences are written in `code`. `LF` is U+000A.

Two audiences are separated throughout:

- A **reader** parses a document into threads.
- A **writer** regenerates a document from threads.

A **conforming implementation** is both. An implementation MAY be read-only, in
which case only the reader requirements apply.

## 2. Design constraints

The format exists to satisfy four constraints. They explain most of the rules
that follow, and an implementation that violates them will produce files that
technically parse but behave badly in practice.

1. **The document is the database.** There is no sidecar file and no service.
   Everything needed to reconstruct the discussion is in the `.md` file.
2. **A reader without the tool sees the discussion.** The file renders on
   github.com as ordinary Markdown, with comments as footnotes.
3. **Output is deterministic.** The generated region is rewritten in full on
   every save and lands in a commit. Two implementations given the same threads
   MUST produce byte-identical output, or every save churns lines nobody edited.
4. **Comments survive edits to the prose.** Anchors are invisible in every
   Markdown renderer, so editing around them does not disturb the reading.

## 3. Data model

```
Document
  body     : Markdown text, containing zero or more anchor pairs
  threads  : ordered list of Thread

Thread
  id       : ThreadID
  anchor   : string   the phrase the thread is about
  status   : "open" | "resolved"
  replies  : ordered list of Reply

Reply
  author   : string   a GitHub login, without "@"
  date     : instant
  text     : string   Markdown
```

`isOrphaned` is derived, not stored. See §7.3.

### 3.1 ThreadID

A ThreadID MUST match:

```
thread-id = 8HEXDIG-LOWER          ; /^[0-9a-f]{8}$/
```

Eight lowercase hexadecimal digits. Writers SHOULD generate one from a
cryptographically secure random source. Uppercase is not permitted and is not
normalised on read; an id containing it will not match its own markers.

Collision risk is 2^-32 per pair of threads in one document, which is acceptable
because a collision merges two threads in one file rather than corrupting
anything, and is visible when it happens.

## 4. Lexical elements

| Element | Literal |
| --- | --- |
| Begin sentinel | `<!-- mdc-comments-begin -->` |
| End sentinel | `<!-- mdc-comments-end -->` |
| Data block opener | `<!-- mdc-comments-data` |
| Data block terminator | `-->` |
| Anchor open marker | `<!--mdc:` *id* `-->` |
| Anchor close marker | `<!--/mdc:` *id* `-->` |
| Footnote reference | `[^mdc-` *id* `]` |
| Footnote definition label | `[^mdc-` *id* `]:` |

These literals are load-bearing and MUST be reproduced exactly, including the
spaces. Note the asymmetry: the three block-level sentinels have spaces inside
the comment delimiters, and the inline anchor markers do not.

The `mdc-` prefix identifies the format. Changing it is a breaking change that
orphans every comment in every document already written.

## 5. Document structure

A document with at least one thread has this shape:

```
document      = body LF LF region LF
region        = begin-sentinel LF
                data-block
                *(LF LF footnote-definition)
                [LF LF unanchored-list]
                LF LF end-sentinel

data-block    = "<!-- mdc-comments-data" LF json LF "-->"
```

Constraints a writer MUST satisfy:

- Exactly one blank line separates the body from the begin sentinel.
- The body has trailing whitespace removed before that separator is added.
- The file ends with the end sentinel followed by exactly one `LF`.
- Everything from the begin sentinel to the end sentinel is generated. A writer
  MUST regenerate all of it on every save and MUST NOT attempt to patch it.

A document with **zero** threads has no region at all. Writers MUST NOT emit an
empty region.

## 6. The data block

The data block is the authoritative copy. The footnote definitions in §7 are a
rendering of it and MUST NOT be parsed.

### 6.1 JSON shape

```json
{"v":1,"threads":[
{"anchor":"jumps over","id":"a1b2c3d4","replies":[{"at":"2026-08-10T14:42:00Z","by":"pjdoland","text":"Is this right?"}],"status":"open"}
]}
```

| Field | Type | Notes |
| --- | --- | --- |
| `v` | integer | Format version. Writers MUST emit `1`. |
| `threads` | array | In document order where anchors exist. |
| `threads[].id` | string | ThreadID (§3.1). |
| `threads[].anchor` | string | The anchored phrase, whitespace as selected. |
| `threads[].status` | string | `"open"` or `"resolved"`. |
| `threads[].replies` | array | Chronological. MAY be empty. |
| `replies[].at` | string | ISO 8601, UTC, seconds precision (§6.4). |
| `replies[].by` | string | GitHub login, no leading `@`. |
| `replies[].text` | string | Markdown, verbatim, newlines preserved. |

No other keys are defined. See §11 for extension rules.

### 6.2 Layout

Writers MUST emit the JSON with:

- object keys in ascending lexicographic order (`anchor`, `id`, `replies`,
  `status`; and `at`, `by`, `text`),
- no insignificant whitespace inside a thread object,
- **one thread per line**, each line except the last followed by `,`,
- the opening `{"v":1,"threads":[` and closing `]}` on their own lines.

The line-per-thread layout is not cosmetic. It is what makes two branches that
each add a comment conflict on their own lines rather than on one long line.

Readers MUST NOT depend on the layout. Any JSON that parses to the specified
shape is valid input.

### 6.3 Escaping inside the data block

The JSON sits inside an HTML comment, so it MUST NOT contain `-->`.

Writers MUST replace **every** `>` in the serialised JSON with the escape
`\u003e`. This is unconditional: `>` appears only inside string values,
and `\u003e` is an equivalent JSON escape, so a blanket replacement is
safe and needs no parsing. `<` is left alone, since `<!--` cannot terminate a comment.

Readers get this for free; `JSON.parse` and equivalents decode `\u003e`
transparently.

### 6.4 Timestamps

`at` MUST be ISO 8601 in UTC at seconds precision, with a literal `Z` and no
fractional part:

```
2026-08-10T14:42:00Z
```

Sub-second precision MUST be truncated, not rounded. Local offsets MUST NOT be
used. A reader encountering an unparseable value MUST substitute the Unix epoch
(`1970-01-01T00:00:00Z`) rather than discarding the reply.

## 7. The visible layer

Everything in this section is regenerated from the data block. It exists so the
document reads correctly for someone without the extension.

### 7.1 Footnote definitions

One definition per **anchored** thread, in the order the threads appear in
`threads`:

```
[^mdc-a1b2c3d4]:
    _(resolved)_ **@pjdoland** · Aug 10, 2026: Is this right?

    **@dreyes** · Aug 11, 2026: Points, not percent.

    Fixing the wording now.
```

Rules:

- The label line is `[^mdc-` *id* `]:` alone.
- Each reply begins a line indented by exactly four spaces, formatted as
  `**@` *login* `** · ` *display-date* `: ` followed by the first line of the
  reply text.
- The separator between login and date is U+00B7 MIDDLE DOT, surrounded by
  single spaces.
- Replies after the first are preceded by one empty line.
- Continuation lines of a reply are indented by four spaces. A line that is
  empty in the source stays empty, with **no** indentation.
- When the thread is `resolved`, the first reply is prefixed with
  `_(resolved)_ ` (note the trailing space). Later replies are not prefixed.

### 7.2 The unanchored list

Threads whose anchor pair is not present in the body get no footnote definition,
because GitHub renders an unreferenced definition as literal text. They are
listed instead, after all footnote definitions:

```
**Unanchored comments**

- on "jumps over":
    - **@pjdoland** · Aug 10, 2026: Is this right?
```

- The heading is the literal `**Unanchored comments**`, followed by one empty
  line.
- One top-level item per thread: `- on "` *anchor* `":`.
- One nested item per reply, indented four spaces, with the same
  `**@login** · date: text` form.
- Newlines in the anchor and in reply text MUST be replaced with a single space,
  since a list item cannot carry them.

The block is emitted only when at least one thread is unanchored.

### 7.3 Determining whether a thread is anchored

A thread is **anchored** when the body contains at least one complete anchor
pair for its id: both an open marker and a close marker, anywhere, in any order.
Otherwise it is **orphaned**.

Readers MUST compute this from the body rather than trusting any stored value.

### 7.4 Escaping in the visible layer

Reply text and anchor text are author-controlled and could otherwise forge a
sentinel and truncate the region. Before emitting into the visible layer,
writers MUST:

1. trim leading and trailing whitespace,
2. replace every `<!--` with `&lt;!--`,
3. replace every `-->` with `--&gt;`.

A bare `>` is **not** escaped here; only the two comment delimiters are. This
differs from §6.3 deliberately: the data block needs `>` gone to stay inside a
comment, the visible layer does not.

This transformation is lossy and one-way. It applies to the rendering only. The
data block always holds the text as written, and readers MUST take reply text
from the data block.

### 7.5 Display dates

`Aug 10, 2026`: three-letter English month abbreviation, day without leading
zero, four-digit year, always in UTC.

This is fixed on purpose. A locale-dependent or timezone-dependent date would
make every save rewrite every comment line for a viewer in another region,
breaking constraint 3.

## 8. Anchors and references

### 8.1 Anchor pairs

A commented range is delimited in the body by an open and close marker:

```
The quick brown fox <!--mdc:a1b2c3d4-->jumps over<!--/mdc:a1b2c3d4--> the lazy dog.
```

HTML comments are stripped by every Markdown renderer, so the prose reads
normally and the markers survive round-tripping through editors that preserve
raw HTML.

Anchors MUST NOT nest or partially overlap. A range that overlaps an existing
pair cannot be represented unambiguously, and an editor that round-trips the
markers can silently drop the inner pair. Writers MUST refuse such a range
rather than emit one.

### 8.2 Reference placement

Each anchored thread gets one or more footnote references in the body. Writers
MUST place them by this rule, for each anchored id:

- Let a marker be **block-initial** when only block structure separates it from
  the start of its line: whitespace, blockquote `>` markers, a list bullet
  (`-`, `*`, `+`, or `1.` / `1)`), and heading `#` characters, in that order.
- If the id has **any** block-initial open marker, insert a reference
  immediately **before** each block-initial open marker, and nowhere else.
- Otherwise, insert one reference immediately **after** the **last** close
  marker for that id.

The block-initial case exists because in CommonMark a line beginning with
`<!--` starts an HTML block, which swallows the rest of the line, strips the
markers, and leaves `[^mdc-...]` rendered as literal text. Leading with `[`
keeps the line ordinary Markdown:

```
## [^mdc-a1b2c3d4]<!--mdc:a1b2c3d4-->A heading<!--/mdc:a1b2c3d4-->
```

GFM permits a footnote to be referenced more than once and renders a backlink
per reference, so multiple references for one id are valid.

References are derived data. Writers MUST strip all existing references before
recomputing them, so the reference set always matches the definition set.

## 9. Reading

Given the full file text, a reader MUST:

1. Find the first `<!-- mdc-comments-begin -->`. If absent, the whole text is
   the body and there are no threads. Stop.
2. Find the first `<!-- mdc-comments-end -->` **after** it. If absent, the whole
   text is the body and there are no threads. Stop. (An unterminated region is
   treated as prose rather than as a truncated region, so a half-written file is
   never silently emptied.)
3. Let *before* be the text preceding the begin sentinel and *after* the text
   following the end sentinel.
4. Remove trailing whitespace from *before*. Trim *after*. If *after* is
   non-empty, append it to *before* separated by one blank line. This preserves
   anything a person typed below the region.
5. Remove every footnote reference matching `[^mdc-` *id* `]` from the result.
   This is the body.
6. Within the region, find `<!-- mdc-comments-data`, then the first `-->` after
   it. Parse the text between them as JSON. On any failure, yield no threads.
7. Accept either the versioned object (`{"v":…,"threads":[…]}`) or, for
   documents predating versioning, a bare array. Anything else yields no
   threads.
8. For each entry: coerce `id`, `anchor`, `by`, and `text` to strings,
   defaulting to empty; map `status` to `"resolved"` only on an exact match and
   to `"open"` otherwise; parse `at` per §6.4.
9. **Discard** any thread whose id does not match §3.1. A malformed id cannot
   match a marker, so the thread could never be located or rewritten correctly.
10. Compute `isOrphaned` per §7.3.

Everything between the sentinels other than the data block is ignored on read.

## 10. Writing

Given a body and an ordered list of threads, a writer MUST:

1. Strip every footnote reference from the body.
2. Collapse **anchor seams**: a close marker immediately followed by an open
   marker for the same id (`<!--/mdc:X--><!--mdc:X-->`) is removed entirely.
   These accumulate when a commented range is split and rejoined by editing.
3. Drop any anchor marker whose id is not among the given threads. This is what
   makes deleting a thread leave no trace in the prose.
4. If there are no threads, stop. The result is the body. **No region is
   emitted and trailing whitespace is not trimmed**, so a file with no comments
   is left byte for byte alone.
5. Compute the anchored set (§7.3) against the body as it now stands.
6. Insert references per §8.2.
7. Emit the region: begin sentinel, data block, a blank line and a footnote
   definition for each anchored thread in order, then if any thread is orphaned
   a blank line and the unanchored list, then a blank line and the end sentinel.
8. Return the body with trailing whitespace removed, then a blank line, then the
   region, then a single `LF`.

Steps 1 to 3 are what makes the format self-healing: the body is normalised
before anything is derived from it, so a document edited by hand or by another
tool converges rather than degrading.

## 11. Versioning and extension

The `v` field exists so a future change to the shape can be a migration rather
than a break.

- Writers MUST emit the current version and MUST NOT emit a version they do not
  fully implement.
- Readers MUST accept version 1 and the unversioned bare array.
- Readers encountering a **higher** version SHOULD parse what they recognise and
  MUST NOT write the document back, since writing would discard fields they did
  not understand.

Adding a field is a version bump. An implementation that adds a key without
bumping will have it silently dropped by the next implementation that saves,
because the region is regenerated in full from the fields that implementation
knows.

Two rules protect the format from data loss and MUST NOT be relaxed:

- Never parse the visible layer. It is lossy (§7.4) and regenerated.
- Never preserve unrecognised text inside the region. It is not a extension
  point; it is output.

## 12. Rendering contract

Informative. This describes what GitHub does with a conforming document, and is
the reason for the rules in §7 and §8.

- HTML comments are removed from rendered output, so anchor markers are
  invisible in the DOM. A tool that wants to locate a commented range in the
  rendered page must work from the footnote reference, which survives and sits
  at exactly one end of the range.
- `[^mdc-ID]` renders as a superscript link at the comment site, and
  `**@login**` renders as a link to that GitHub profile.
- GFM hoists every footnote definition into a single `<section data-footnotes>`
  at the end of the document, numbered in reference order. The numbering is
  GitHub's and is not stable across edits.
- A footnote definition with no matching reference renders as literal text,
  which is why orphaned threads are listed as prose instead (§7.2).

## 13. Conformance vectors

Every vector below was produced by the reference implementation. A conforming
writer MUST produce these bytes exactly. Dates are
`2026-08-10T14:42:00Z` and `2026-08-11T09:05:30Z`.

### 13.1 One thread, one reply

Input body: `The quick brown fox <!--mdc:a1b2c3d4-->jumps over<!--/mdc:a1b2c3d4--> the lazy dog.`
Thread: id `a1b2c3d4`, anchor `jumps over`, status `open`, one reply by
`pjdoland` reading `Is this right?`.

````markdown
The quick brown fox <!--mdc:a1b2c3d4-->jumps over<!--/mdc:a1b2c3d4-->[^mdc-a1b2c3d4] the lazy dog.

<!-- mdc-comments-begin -->
<!-- mdc-comments-data
{"v":1,"threads":[
{"anchor":"jumps over","id":"a1b2c3d4","replies":[{"at":"2026-08-10T14:42:00Z","by":"pjdoland","text":"Is this right?"}],"status":"open"}
]}
-->

[^mdc-a1b2c3d4]:
    **@pjdoland** · Aug 10, 2026: Is this right?

<!-- mdc-comments-end -->
````

### 13.2 Resolved, two replies, one spanning paragraphs

Second reply text is `Points, not percent.\n\nFixing the wording now.`

````markdown
[^mdc-a1b2c3d4]:
    _(resolved)_ **@pjdoland** · Aug 10, 2026: Is this right?

    **@dreyes** · Aug 11, 2026: Points, not percent.

    Fixing the wording now.
````

Note the blank line between the two paragraphs of the second reply carries no
indentation, while the continuation line does.

### 13.3 Block-initial anchor

Input body: `## <!--mdc:a1b2c3d4-->A heading<!--/mdc:a1b2c3d4-->\n\nBody text.`

````markdown
## [^mdc-a1b2c3d4]<!--mdc:a1b2c3d4-->A heading<!--/mdc:a1b2c3d4-->

Body text.
````

The reference precedes the open marker because the marker is block-initial.

### 13.4 Orphaned thread

Input body contains no anchor pair for the thread.

````markdown
No anchors left in this text at all.

<!-- mdc-comments-begin -->
<!-- mdc-comments-data
{"v":1,"threads":[
{"anchor":"jumps over","id":"a1b2c3d4","replies":[{"at":"2026-08-10T14:42:00Z","by":"pjdoland","text":"Is this right?"}],"status":"open"}
]}
-->

**Unanchored comments**

- on "jumps over":
    - **@pjdoland** · Aug 10, 2026: Is this right?

<!-- mdc-comments-end -->
````

### 13.5 Escaping

Anchor `a > b`, reply text `careful: <!-- and --> and 5 > 3`.

````markdown
<!-- mdc-comments-data
{"v":1,"threads":[
{"anchor":"a \u003e b","id":"a1b2c3d4","replies":[{"at":"2026-08-10T14:42:00Z","by":"pjdoland","text":"careful: <!-- and --\u003e and 5 \u003e 3"}],"status":"open"}
]}
-->

[^mdc-a1b2c3d4]:
    **@pjdoland** · Aug 10, 2026: careful: &lt;!-- and --&gt; and 5 > 3
````

Every `>` in the data block becomes `\u003e`, including the one inside
`--` + `>`. Only the comment delimiters are escaped in the visible layer, so
`5 > 3` keeps its `>` there.

### 13.6 No threads

`join("A <!--mdc:a1b2c3d4-->b<!--/mdc:a1b2c3d4-->[^mdc-a1b2c3d4] c", [])` yields
exactly `A b c`. No region, markers and references removed.

### 13.7 Text below the region

A file with prose after the end sentinel round-trips: the prose is appended to
the body separated by a blank line, and is written back above the region on the
next save. It is not lost.

## 14. Reader robustness

A conforming reader MUST NOT throw on any input. Specifically:

| Input | Behaviour |
| --- | --- |
| No begin sentinel | Whole text is body, no threads |
| Begin without end | Whole text is body, no threads |
| Data block absent from region | No threads |
| Data block is not valid JSON | No threads |
| JSON is neither object-with-`threads` nor array | No threads |
| Thread id fails §3.1 | That thread discarded |
| `status` missing or unrecognised | `"open"` |
| `at` missing or unparseable | Unix epoch |
| `by`, `text`, `anchor` missing | Empty string |
| `replies` missing | Empty list |
| Duplicate ids | Not specified; implementations SHOULD keep the first |

Yielding no threads is always preferred to yielding wrong ones. A document whose
region cannot be understood MUST be left alone rather than rewritten, or an
unreadable region becomes a destroyed one.

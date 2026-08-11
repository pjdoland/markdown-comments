# Markdown Comments

A Chrome extension that puts Google Docs style comments on Markdown files as you
read them on github.com.

Select a phrase, leave a comment, and it is committed straight to the file. The
comment lives inside the `.md` itself, so anyone reading that file on github.com
without this extension still sees the whole discussion as ordinary footnotes.
There is no database, no service, and no sidecar file.

The same format is read and written by
[RepoNotepad](https://github.com/pjdoland/repo-notepad), a macOS Markdown editor,
so a document can be authored there and reviewed here.

## Install

Not on the Chrome Web Store. Load it unpacked:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. **Load unpacked**, and pick this directory
4. Open the extension's **Options** and paste a
   [fine-grained personal access token](https://github.com/settings/tokens?type=beta)
   with **Contents: read and write** on the repositories you want to comment in

Reading public repositories works without a token. A token is required to post,
and to read private repositories.

## Use

Works anywhere GitHub renders Markdown from a repository:

- a file: `github.com/owner/repo/blob/main/notes.md`
- a repository home page, which renders the README
- a directory listing (`/tree/...`), which renders that directory's README

The panel appears on the right and the commented phrases are highlighted in the
document. It shifts the page rather than covering it.

- **Show or hide**: click the extension's toolbar icon, press **Alt+C**, or use
  the floating Comments button. The choice is remembered across pages, and the
  shortcut can be rebound at `chrome://extensions/shortcuts`.
- **Comment**: select text, then click the Comment button that appears (or press
  Cmd-Alt-M). The comment is committed and pushed as soon as you post it.
- **Navigate**: click a highlight to focus its thread, or a thread to scroll to
  its highlight.
- **Reply / Resolve / Delete**: select a thread in the panel. Replying to a
  resolved thread reopens it.

While a page is open the file is re-checked once a minute, so comments left by
other people appear without a reload. The check is a conditional request, so an
unchanged file costs a 304 and does not count against the API rate limit. If you
are part-way through writing something, an update is announced rather than
applied, so nothing you typed is discarded.

Comments are attributed by display name where the person has one, falling back
to `@handle`. The file itself always stores the handle, which is what makes
GitHub render it as a real profile link. Timestamps are shown in your own time
zone, shortened to the time for today and the day for this year, with the full
value including time zone on hover.

Each action is one commit through the GitHub Contents API, using the blob `sha`
for optimistic concurrency. If someone else changed the file since you loaded
it, the write fails cleanly rather than clobbering their edit.

## How it looks in the file

```markdown
The quick brown fox <!--rn:1a2b3c4d-->jumps over the lazy dog<!--/rn:1a2b3c4d-->[^rn-1a2b3c4d] every morning.

<!-- rn-comments-begin -->
<!-- rn-comments-data
[{"anchor":"jumps over the lazy dog","id":"1a2b3c4d","replies":[...],"status":"open"}]
-->

[^rn-1a2b3c4d]:
    **@pjdoland** · Aug 10, 2026: Is "jumps" right here?

    **@alice** · Aug 10, 2026: Yes, present tense is intentional.

<!-- rn-comments-end -->
```

The anchor pair is invisible in every Markdown renderer. The JSON block is the
authoritative copy. The footnote definitions are the human-visible layer, which
GitHub renders as a superscript link at the comment site with a threaded note at
the bottom. Everything from the begin sentinel onward is regenerated on save, so
the visible layer cannot drift from the JSON. A file with no comments is left
byte for byte alone.

Two details are load-bearing and easy to get wrong:

**A reference leads a block-initial anchor.** In CommonMark a line beginning with
`<!--` starts an HTML block, which swallows the rest of the line, strips the
markers, and leaves `[^rn-…]` rendered as literal text. So when the opening
marker is the first thing on its line the reference goes in front of it, keeping
the line ordinary Markdown. A multi-span anchor gets one reference per
block-initial marker.

**Orphans get no footnote definition.** GitHub renders an unreferenced definition
as literal text, so a thread whose anchored text was deleted moves to a plain
"Unanchored comments" list instead.

The `rn-` prefix throughout the format is inherited from RepoNotepad, where the
format originated. It is deliberately frozen: changing it would orphan the
comments in every document already written, and break the guarantee that both
tools produce identical bytes.

## How it works

GitHub strips HTML comments from its rendered output, so the anchor markers are
not visible in the DOM and the raw source has to be fetched separately. What does
survive is the footnote reference, sitting at exactly the end (or, for
block-initial anchors, the start) of the anchored range. Recovering the range is
then a walk of that many characters from the reference, which is unambiguous even
when the same phrase appears elsewhere.

| File | Role |
| --- | --- |
| `src/codec.js` | The file format. A port of RepoNotepad's `CommentCodec.swift`, with byte-identical output enforced by `test/parity.sh`. |
| `src/content/anchor.js` | Finds each thread's range in the rendered DOM and highlights it. |
| `src/content/sourcemap.js` | Maps a rendered selection back to an offset in the raw Markdown. |
| `src/content/panel.js` | The margin panel. |
| `src/content/main.js` | Orchestration, soft-navigation handling, commit flow. |
| `src/background.js` | GitHub API calls, so the token never enters a page context. |

Highlights use the CSS Custom Highlight API rather than wrapping text in spans.
GitHub's blob view is a React tree and injected elements get discarded on
re-render; highlights live outside the DOM entirely.

The source map only has to be good enough to *locate* a phrase, not to render
one. Every result is verified before use and an unverifiable match is refused,
because anchoring the wrong span is worse than declining to anchor.

## Tests

```bash
node --test test/codec.test.js
node --test test/sourcemap.test.js
test/parity.sh    # Swift and JS codecs must agree exactly, byte for byte
```

The DOM layer is verified against HTML from GitHub's own Markdown renderer
(`POST /markdown`) rather than a local approximation, since the whole design
depends on how GitHub actually renders footnotes and strips comments.

## Limits

- **Read and comment, not edit.** GitHub's rendered blob view is not an editor.
  Use RepoNotepad to write prose.
- **A comment that arrives while you are reading cannot always be highlighted.**
  The page render predates it, so there is no footnote reference to anchor
  against. The thread still appears in the panel, and the highlight is recovered
  when its anchor text occurs exactly once; otherwise it waits for a reload.
- **Comments cannot nest.** Selecting text that overlaps an existing comment is
  refused, because the rich editor in RepoNotepad skips text already inside a
  comment span and would drop the inner markers on its next save.
- **After posting, the page render is stale** until you reload. The new
  highlight is kept in memory, but the footnote section at the bottom still
  shows the previous state.
- **Selections spanning images or emoji shortcodes may not map.** They render as
  elements with no text, so the projection and the DOM disagree. The extension
  refuses rather than guessing.
- **GitHub's DOM will change.** Site-specific extensions need periodic repair.

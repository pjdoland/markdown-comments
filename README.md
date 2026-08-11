# Markdown Comments

Google Docs style comments on Markdown files, right where you read them on
github.com. The comments live inside the `.md` file itself.

![The comments panel open beside a Markdown document on GitHub, with commented phrases highlighted in the prose](docs/panel-light.png)

## Why

Reviewing a design doc in a pull request means arguing about diffs. Moving it to
Google Docs means it stops living in the repository. This keeps the document
where it belongs and adds the part that was missing: select a phrase, say
something about it, get a reply.

Because a comment is written into the Markdown, there is no database, no service,
and no sidecar file to lose. Anyone who opens that file on github.com without
this extension still sees the entire discussion, rendered as ordinary footnotes.

## Install

Not on the Chrome Web Store yet. Load it unpacked:

1. Open `chrome://extensions`
2. Turn on **Developer mode**
3. Choose **Load unpacked** and select this directory
4. Open the extension's **Options** and add a
   [fine-grained personal access token](https://github.com/settings/tokens?type=beta)

The token needs **Contents: read and write**, and it must list the repositories
you want to comment in. Fine-grained tokens grant access per repository, so a
valid token is not the same as one that can reach a given repo. The options page
has a **Check repository access** button that tells you which you have.

Reading public repositories works with no token at all.

## Using it

It runs anywhere GitHub renders Markdown from a repository:

| Page | Renders |
| --- | --- |
| `github.com/owner/repo/blob/main/notes.md` | that file |
| `github.com/owner/repo` | the repository README |
| `github.com/owner/repo/tree/main/docs` | that directory's README |

**Leave a comment.** Select text in the document and a Comment button appears.
Type, submit, and it is committed and pushed immediately.

![Text selected in the document with a Comment button beneath it and a draft comment open in the panel](docs/new-comment.png)

**Everything else.** Click a highlight to jump to its thread, or a thread to jump
to its highlight. Select a thread to reply, resolve, or delete it. Replying to a
resolved thread reopens it.

**Show or hide the panel** with the toolbar icon, <kbd>Alt</kbd>+<kbd>C</kbd>, or
the floating Comments button. The choice is remembered, and the shortcut can be
rebound at `chrome://extensions/shortcuts`. The panel narrows the page rather
than covering it, and it follows your GitHub theme.

![The same document and panel in dark mode](docs/panel-dark.png)

Open pages re-check the file every minute, so comments from other people arrive
without a reload. If you are part-way through writing something, the update is
announced instead of applied, so nothing you typed is lost.

Every action is a single commit through the GitHub Contents API, using the blob
SHA for optimistic concurrency. If someone else changed the file since you loaded
it, your write fails cleanly instead of overwriting their edit.

## How comments are stored

Three pieces, all inside the document:

```markdown
Activation rose <!--mdc:a1b2c3d4-->11% against control<!--/mdc:a1b2c3d4-->[^mdc-a1b2c3d4], and it held.

<!-- mdc-comments-begin -->
<!-- mdc-comments-data
[{"anchor":"11% against control","id":"a1b2c3d4","replies":[...],"status":"open"}]
-->

[^mdc-a1b2c3d4]:
    **@pjdoland** · Aug 10, 2026: Relative or absolute?

    **@dreyes** · Aug 10, 2026: Points. Fixing the wording.

<!-- mdc-comments-end -->
```

The **anchor pair** marks the commented range and is invisible in every Markdown
renderer, so the prose reads normally. The **JSON block** is the authoritative
copy and the only thing the extension parses. The **footnote definitions** are
the human-visible layer: GitHub turns the reference into a superscript at the
comment site, and the `@handle` into a real profile link.

Everything from the begin sentinel onward is regenerated on every save, so the
visible layer cannot drift from the JSON. A file with no comments is left byte
for byte alone.

Two rules in the format are load-bearing and easy to get wrong:

**A reference leads a block-initial anchor.** In CommonMark a line beginning with
`<!--` starts an HTML block, which swallows the rest of the line, strips the
markers, and leaves `[^mdc-...]` rendered as literal text. So when the opening
marker is the first thing on its line, the reference goes in front of it and the
line stays ordinary Markdown. A range spanning several blocks gets one reference
per block.

**Orphans get no footnote definition.** GitHub renders an unreferenced definition
as literal text, so a thread whose anchored text was deleted moves to a plain
"Unanchored comments" list instead of being dropped.

Changing the `mdc-` prefix is a breaking change: it orphans the comments in every
document already written.

## How it works

GitHub strips HTML comments from its rendered output, so the anchor markers are
invisible in the DOM and the raw source has to be fetched separately. What does
survive is the footnote reference, sitting at exactly the end of the anchored
range, or the start for a block-initial anchor. Recovering the range is then a
walk of that many characters from the reference, which stays unambiguous even
when the same phrase appears elsewhere in the document.

| File | Role |
| --- | --- |
| `src/codec.js` | The file format: parsing and regenerating the comment region |
| `src/content/anchor.js` | Finds each thread's range in the rendered DOM and highlights it |
| `src/content/sourcemap.js` | Maps a rendered selection back to an offset in the raw Markdown |
| `src/content/panel.js` | The comments panel |
| `src/content/main.js` | Orchestration, soft navigation, polling, commit flow |
| `src/background.js` | GitHub API calls, so the token never enters a page context |

Highlights use the CSS Custom Highlight API rather than wrapping text in spans.
GitHub's blob view is a React tree and injected elements get discarded on
re-render, so the highlights live outside the DOM entirely.

The source map only has to be good enough to *locate* a phrase, not to render
one. Every result is verified before use and an unverifiable match is refused,
because anchoring a comment to the wrong words is worse than declining to anchor
it at all.

## Development

No build step. This is plain JavaScript, loaded directly by Chrome.

```bash
node --test test/codec.test.js       # the file format
node --test test/sourcemap.test.js   # selection to source mapping
```

The DOM layer is checked against HTML from GitHub's own Markdown renderer
(`POST /markdown`) rather than a local approximation, since the whole design
rests on how GitHub actually renders footnotes and strips comments.

## Limitations

- **It comments, it does not edit.** GitHub's rendered view is not an editor, so
  this adds a discussion layer rather than a way to rewrite prose.
- **Comments cannot nest.** Selecting text that overlaps an existing comment is
  refused. Overlapping ranges cannot be represented unambiguously, and an editor
  that round-trips the markers can silently drop the inner pair.
- **After posting, the rendered page is stale** until you reload. The new
  highlight is kept in memory, but the footnote section still shows the previous
  state.
- **A comment that arrives while you are reading may not highlight.** The page
  render predates it, so there is no reference to anchor against. The thread
  still appears in the panel, and the highlight is recovered when its anchor text
  occurs exactly once.
- **Selections spanning images or emoji shortcodes may not map.** They render as
  elements with no text, so the projection and the DOM disagree. The extension
  refuses rather than guessing.
- **GitHub's DOM will change.** Extensions that inject into someone else's site
  need periodic repair.

## License

Not yet licensed. Add a `LICENSE` file before sharing this beyond yourself.

# Chrome Web Store listing

Copy for the developer dashboard, kept here so the submitted text is reviewable
and versioned rather than living only in a web form. Update this file when the
listing changes.

Privacy policy URL to paste into the dashboard:

```
https://github.com/pjdoland/markdown-comments/blob/main/docs/PRIVACY.md
```

## Name

```
Markdown Comments
```

## Short description

Store limit is 132 characters. This is 118.

```
Google Docs style comments on Markdown files in GitHub repositories, stored inside the file itself. No server, no database.
```

## Detailed description

```
Reviewing a design doc in a pull request means arguing about diffs. Moving it to Google Docs means it stops living in the repository. Markdown Comments keeps the document where it belongs and adds the part that was missing: select a phrase, say something about it, get a reply.

HOW IT WORKS

Open any Markdown file on github.com. Select some text and a Comment button appears. Type, submit, and the comment is committed to the file as a single commit through the GitHub API. Click a highlight to jump to its thread, or a thread to jump to its highlight. Reply, resolve, reopen, or delete.

THE COMMENTS LIVE IN THE FILE

There is no database, no service, and no sidecar file to lose. A comment is written into the Markdown itself: an invisible anchor around the phrase, and a footnote holding the discussion. Anyone who opens that file on github.com without this extension still sees the entire conversation, rendered as ordinary footnotes. Clone the repository and the comments come with it.

WHAT YOU GET

- Comments anchored to a phrase, highlighted in the prose
- Threaded replies, resolve and reopen
- Replies render as Markdown: lists, code blocks, links
- Works on any Markdown file, on a repository README, and on a directory README
- Follows your GitHub theme, light and dark
- Keyboard navigation: j and k between threads, r to reply, e to resolve
- Alt+C to show or hide the panel, rebindable
- Comments from other people arrive without a reload
- If a comment's text gets edited, the extension offers to re-anchor it
- If the branch refuses direct commits, it offers to open a pull request instead

WHAT IT NEEDS

A GitHub personal access token, added in the extension's Options, with Contents: read and write on the repositories you want to comment in. Reading public repositories works with no token at all.

PRIVACY

No server, no analytics, no telemetry. The extension talks to nothing except GitHub's API, using your token, on your behalf. Full policy:
https://github.com/pjdoland/markdown-comments/blob/main/docs/PRIVACY.md

The file format is documented and open, so the comments are not locked to this tool:
https://github.com/pjdoland/markdown-comments/blob/main/docs/FORMAT.md
```

## Category

Developer Tools

## Single purpose

Reviewers reject vague statements here. This names the one thing the extension
does.

```
Reading and writing review comments on Markdown files hosted in GitHub repositories. The extension adds a comments panel to github.com pages that render Markdown, and stores each comment inside the Markdown file itself as an anchor and a footnote, committed through the GitHub API.
```

## Permission justifications

### `storage`

```
Stores the user's GitHub personal access token, their GitHub login name, and whether the comments panel was left open. The token is required to read a file's source and to commit comments back. All three stay on the user's device; none is transmitted anywhere except the token, which is sent only as an Authorization header to api.github.com.
```

### `https://api.github.com/*`

```
Every read and write goes through the GitHub REST API: fetching a Markdown file's source so its comments can be parsed, committing a comment back to the file, and resolving display names for the people in a discussion. Requests are made from the extension's service worker so that the access token is never present in any page context.
```

### `https://github.com/*`

```
The comments panel is drawn on github.com pages that render Markdown, and the extension must read the rendered document to locate the commented phrase and highlight it. The match is the whole domain because a Markdown file can appear under many paths: /blob/ for a file, the repository root and /tree/ for READMEs, with arbitrary branch names in between. The content script determines at runtime whether the current page is one of those and does nothing on any other page.
```

### Permissions deliberately not requested

Worth having ready, since a reviewer may wonder why `chrome.tabs` is called
without the permission.

- **`tabs`** is not requested. `chrome.tabs.query` and `chrome.tabs.sendMessage`
  are used to route the toolbar click and the Alt+C command to the active tab,
  and only `tab.id` is read. The permission is needed solely to read `url`,
  `title` or `favIconUrl`, none of which this extension touches.
- **`scripting`** is not requested. Content scripts are declared statically in
  the manifest and nothing is injected at runtime.
- **`activeTab`** is not requested. The content script is already declared for
  github.com, so there is nothing for it to grant.

## Privacy practices: data collected

Declare these and nothing else.

| Category | Declare | Why |
| --- | --- | --- |
| Authentication information | **Yes** | The GitHub personal access token, stored locally |
| Website content | **Yes** | The Markdown file's text is read to parse and write comments |
| Personally identifiable information | **Yes** | The GitHub login name of the signed-in user, stored to attribute comments |
| Personal communications | **No** | Comments are the user's own content written to their own repository, not messages the extension collects |
| Location, financial, health, web history, user activity | **No** | None of these are touched |

Certifications to check:

- Not being sold to third parties.
- Not being used or transferred for purposes unrelated to the single purpose.
- Not being used or transferred to determine creditworthiness or for lending.

## Limited Use disclosure

Required on the homepage or one click away. It is in the privacy policy, which
is linked from the first screen of the README, so both routes are covered.

## Assets

| Asset | File | Size |
| --- | --- | --- |
| Store icon | `icons/icon128.png` | 128x128 |
| Screenshot 1 | `store/screenshot-panel-light.png` | 1280x800 |
| Screenshot 2 | `store/screenshot-new-comment.png` | 1280x800 |
| Screenshot 3 | `store/screenshot-panel-dark.png` | 1280x800 |
| Small promo tile | `store/promo-tile-440x280.png` | 440x280 |

A marquee tile (1400x560) is not supplied. It is optional, and without it the
extension is simply not eligible for marquee featuring.

## Before each submission

1. `node --test test/*.test.js` passes.
2. Bump `version` in `manifest.json`.
3. `./package.sh`, then load the unpacked build in a fresh Chrome profile and
   confirm first run by hand: installing opens the options page, the toolbar
   badge shows `!` until a token is saved or the reminder is dismissed, and it
   clears afterwards. None of that can be checked automatically, because
   headless Chrome silently refuses `--load-extension`.
4. Upload the ZIP that `package.sh` printed.
5. Confirm the privacy policy URL still resolves. A dead link is treated as no
   policy at all, and the repository must stay public for it to resolve.

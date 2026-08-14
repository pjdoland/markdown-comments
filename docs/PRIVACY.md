# Privacy policy

**Markdown Comments** (the "extension"). Last updated 14 August 2026.

The short version: the extension has no backend. There is no server operated by
the developer, no analytics, no telemetry, and no third party of any kind. The
only place it sends anything is GitHub, on your behalf, using your own
credentials.

## What is stored on your device

Everything below is kept in Chrome's extension storage, on your computer. None
of it is transmitted to the developer, because there is nowhere for it to go.

| Stored | Why | Where |
| --- | --- | --- |
| Your GitHub personal access token | To read and write files in the repositories you choose | `chrome.storage.local` |
| Your GitHub login name | To show which account is connected, and to attribute comments you write | `chrome.storage.local` |
| Whether the comments panel is open | To reopen it the way you left it | `chrome.storage.local` |

The token is held by the extension's background service worker and is never
exposed to any web page, including github.com itself. It is sent only as an
`Authorization` header to `https://api.github.com`.

## What is sent, and to whom

Only to GitHub, over HTTPS, and only to these endpoints:

| Request | Purpose |
| --- | --- |
| `GET /repos/{owner}/{repo}/contents/{path}` | Read the Markdown file you are viewing, so its comments can be parsed |
| `GET /repos/{owner}/{repo}/readme` | The same, for a repository or directory README |
| `PUT /repos/{owner}/{repo}/contents/{path}` | Commit a comment you wrote |
| `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` | Find where to branch from, only in the case below |
| `POST /repos/{owner}/{repo}/git/refs` | Create a branch, only when you accept the offer to do so because the current branch refuses direct commits |
| `POST /repos/{owner}/{repo}/pulls` | Open a pull request, in the same case |
| `GET /repos/{owner}/{repo}` | Check whether your token can reach a repository, only when you press **Check repository access** in Options |
| `GET /user` | Confirm which account your token belongs to |
| `GET /users/{login}` | Fetch display names and avatars for people in a discussion |

The contents of the Markdown files you open are read by the extension in order
to find and write comments. That content goes only back to GitHub, where it
already lives.

Comments you write are committed to your repository under your own GitHub
account, exactly as if you had edited the file yourself. They are as public or
as private as that repository is.

## What is not collected

- No analytics, usage statistics, crash reports, or identifiers.
- No browsing history. The extension activates only on `github.com`, and only
  parses the page when it is a Markdown file or a README.
- No advertising, no profiling, no data sold or shared with anyone.
- No data of any kind is transmitted to the developer.

## Retention and deletion

Data stays on your device until you remove it. To delete everything:

- Open the extension's **Options** and use **Remove token**, which clears the
  token and login name; or
- Uninstall the extension, which removes all of its stored data.

You can revoke the token itself at any time from
[GitHub's token settings](https://github.com/settings/tokens), independently of
this extension. Doing so takes effect immediately and is the surest way to end
its access.

## Security

Requests are made over HTTPS only. The token never enters a page context: all
network calls are made from the extension's service worker, which is why the
extension asks for host permissions rather than injecting credentials into
github.com.

Be aware of the limit of that protection. The token is stored in Chrome's
extension storage, which is not encrypted at rest. Anyone with access to your
operating system user account, or to another extension with sufficient
privileges, could read it. Use a fine-grained personal access token scoped to
only the repositories you intend to comment in, with **Contents: read and
write** and nothing more, so that the worst case is bounded.

## Children

The extension is a developer tool and is not directed to children under 13.

## Limited Use disclosure

The use of information received from Google APIs, and any other user data
obtained through this extension, adheres to the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq),
including the Limited Use requirements. Data is used solely to provide the
single user-facing feature described on the store listing: reading and writing
comments inside Markdown files in repositories you choose. It is not
transferred to third parties, not used for advertising, not sold, and not used
for any purpose unrelated to that feature. No human reads your data, because it
never leaves your device except to go to GitHub.

## Changes

If the data handling described here changes, this document will be updated and
the change will be described in the extension's release notes before the new
version is published.

## Contact

Questions or requests: open an issue at
[github.com/pjdoland/markdown-comments/issues](https://github.com/pjdoland/markdown-comments/issues).

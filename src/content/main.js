/**
 * Wires the pieces together on a GitHub blob page for a Markdown file.
 *
 * Flow: parse the location, pull the raw source through the API (which also
 * yields the blob sha needed to write), split out the comment threads, locate
 * each one in the rendered DOM, highlight, and show the panel. Writes go back
 * through the Contents API as a commit.
 */
(function () {
  'use strict';

  const MARKDOWN_PATH = /\.(md|markdown|mdown|mkd)$/i;
  const SHA_REF = /^[0-9a-f]{40}$/i;

  let state = null;
  let selectionButton = null;
  let lastHref = '';

  // MARK: - Messaging

  function send(message) {
    return new Promise(function (resolve, reject) {
      let responded = false;
      try {
        chrome.runtime.sendMessage(message, function (response) {
          responded = true;
          if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
          if (!response) return reject(new Error('No response from the extension.'));
          if (!response.ok) {
            const failure = new Error(response.error || 'Request failed.');
            failure.status = response.status || 0;
            failure.protectedBranch = !!response.protectedBranch;
            return reject(failure);
          }
          resolve(response.result);
        });
      } catch (error) {
        if (!responded) reject(new Error('Extension was reloaded. Refresh the page.'));
      }
    });
  }

  // MARK: - Where are we

  function markdownBody() {
    return document.querySelector('article.markdown-body') || document.querySelector('.markdown-body');
  }

  /**
   * Splits `<ref>/<path>` from a blob URL. Branch names may contain slashes, so
   * the branch picker's label is consulted first and only trusted when the URL
   * actually starts with it.
   */
  function splitRefAndPath(rest) {
    const picker = document.querySelector(
      '#branch-picker-repos-header-ref-selector, [data-testid="branch-picker"], [data-hotkey="w"]'
    );
    const label = picker && picker.textContent ? picker.textContent.trim() : '';
    if (label && rest.startsWith(label + '/')) {
      return { ref: label, path: rest.slice(label.length + 1) };
    }
    const slash = rest.indexOf('/');
    if (slash === -1) return null;
    return { ref: rest.slice(0, slash), path: rest.slice(slash + 1) };
  }

  // Two-segment paths that are GitHub's own pages, not repositories.
  const RESERVED_OWNERS = new Set([
    'settings', 'notifications', 'explore', 'marketplace', 'topics', 'collections',
    'sponsors', 'orgs', 'users', 'features', 'pricing', 'about', 'login', 'join',
    'new', 'codespaces', 'pulls', 'issues', 'dashboard', 'search', 'apps', 'account'
  ]);

  /**
   * Recognises the three places GitHub renders Markdown from a repository:
   * a file (`/blob/`), the repository home, and a directory listing, the last
   * two of which show a README.
   */
  function parseLocation() {
    const parts = location.pathname.replace(/\/+$/, '').split('/').filter(Boolean);
    if (parts.length < 2) return null;

    const owner = parts[0];
    const repo = parts[1];
    if (RESERVED_OWNERS.has(owner.toLowerCase())) return null;

    if (parts.length === 2) {
      return { kind: 'readme', owner: owner, repo: repo, ref: null, dir: '' };
    }

    const section = parts[2];
    let rest = parts.slice(3).join('/');
    try {
      rest = decodeURIComponent(rest);
    } catch (e) { /* keep the raw form */ }

    if (section === 'blob') {
      const split = splitRefAndPath(rest);
      if (!split || !MARKDOWN_PATH.test(split.path)) return null;
      return { kind: 'blob', owner: owner, repo: repo, ref: split.ref, path: split.path };
    }

    if (section === 'tree') {
      if (!rest) return { kind: 'readme', owner: owner, repo: repo, ref: null, dir: '' };
      const split = splitRefAndPath(rest);
      // `/tree/<ref>` with no directory is the repository root on that ref.
      if (!split) return { kind: 'readme', owner: owner, repo: repo, ref: rest, dir: '' };
      return { kind: 'readme', owner: owner, repo: repo, ref: split.ref, dir: split.path };
    }

    return null;
  }

  // MARK: - Rendering

  function cloneThread(thread) {
    return {
      id: thread.id,
      status: thread.status,
      anchor: thread.anchor,
      isOrphaned: thread.isOrphaned,
      replies: thread.replies.map(function (reply) {
        return { author: reply.author, date: reply.date, text: reply.text };
      })
    };
  }

  /**
   * Where each orphaned thread's text appears to have gone.
   *
   * Computed when the body changes rather than on every refresh: it scans the
   * whole document per orphan, and the answer cannot change until someone edits
   * the file. A thread the reader has already waved away stays waved away for
   * the rest of the session.
   */
  function findReanchorCandidates() {
    state.candidates = new Map();
    for (const thread of state.threads) {
      if (!thread.isOrphaned || state.dismissed.has(thread.id)) continue;
      const candidate = MDCSourceMap.findFuzzySpan(state.body, thread.anchor);
      if (candidate) state.candidates.set(thread.id, candidate);
    }
  }

  function buildEntries(root) {
    const entries = state.threads.map(function (thread) {
      let range = state.overrides.get(thread.id) || null;
      if (!range && !thread.isOrphaned) range = MDCAnchor.locate(root, thread);
      return {
        id: thread.id,
        thread: thread,
        range: range,
        candidate: state.candidates.get(thread.id) || null
      };
    });
    entries.sort(function (a, b) {
      if (!a.range && !b.range) return 0;
      if (!a.range) return 1;
      if (!b.range) return -1;
      try {
        return a.range.compareBoundaryPoints(Range.START_TO_START, b.range);
      } catch (e) {
        return 0;
      }
    });
    return entries;
  }

  function refresh() {
    const root = markdownBody();
    if (!state || !root) return;
    state.entries = buildEntries(root);
    MDCAnchor.applyHighlights(state.entries, state.selectedID);
    applyPlumbingVisibility(MDCPanel.isOpen());
    MDCPanel.render(state);
  }

  function selectThread(id) {
    if (!state) return;
    state.selectedID = id;
    refresh();
    if (id) {
      const entry = state.entries.find(function (e) { return e.id === id; });
      MDCAnchor.scrollTo(entry);
      MDCPanel.scrollCardIntoView(id);
    }
  }

  // MARK: - Writing

  /**
   * The file as this change would leave it, built from what we currently hold.
   *
   * Mutations are applied rather than stored, so the same change can be built
   * again against a newer version of the file. That is what makes recovering
   * from a losing race possible instead of asking the reader to retype.
   */
  function composeWrite(mutate) {
    const next = { body: state.body, threads: state.threads.map(cloneThread) };
    mutate(next);
    return MDCCodec.join(next.body, next.threads);
  }

  async function writeOnce(mutate, message) {
    const text = composeWrite(mutate);
    const result = await send({
      type: 'putFile',
      owner: state.location.owner,
      repo: state.location.repo,
      path: state.location.path,
      branch: state.location.ref,
      text: text,
      sha: state.sha,
      message: message
    });
    state.sha = result.sha;
    const reparsed = MDCCodec.split(text);
    state.body = reparsed.body;
    state.threads = reparsed.threads;
  }

  /** Replaces what we think the file holds with what it actually holds. */
  async function reloadSource() {
    const file = await send({
      type: 'getFile',
      owner: state.location.owner,
      repo: state.location.repo,
      path: state.location.path,
      ref: state.location.ref
    });
    const parsed = MDCCodec.split(file.text);
    state.sha = file.sha;
    state.body = parsed.body;
    state.threads = parsed.threads;
    findReanchorCandidates();
  }

  async function commit(mutate, message) {
    if (!state || !state.canWrite) return false;

    state.busy = 'Saving to GitHub...';
    state.error = null;
    state.notice = null;
    state.blockedWrite = null;
    state.pullRequest = null;
    MDCPanel.render(state);

    let carried = null;
    try {
      await writeOnce(mutate, message);
      state.busy = null;
      return true;
    } catch (error) {
      carried = error;
    }

    // A 409 means the blob moved under us: someone else committed, or our own
    // view of the file was behind. Adding a comment does not conflict with
    // whatever they did, so it is re-applied on top of their version. The
    // second failure is the one worth reporting.
    if (carried.status === 409 && !carried.protectedBranch) {
      try {
        await reloadSource();
        await writeOnce(mutate, message);
        state.busy = null;
        state.notice = 'The file had changed on GitHub. Your change was applied on top of it.';
        return true;
      } catch (again) {
        carried = again;
      }
    }

    state.busy = null;
    if (carried.protectedBranch) {
      // The write is not wrong, just not allowed here. Keep it so the panel
      // can offer to put it on a branch instead of losing what was typed.
      state.blockedWrite = { text: composeWrite(mutate), message: message };
      state.error = carried.message;
      return false;
    }
    // Reaching here on a 409 means re-applying lost the race too, which is
    // either a very busy file or something structurally wrong. Reloading is
    // then the honest advice, having already tried the thing that usually works.
    state.error = carried.status === 409
      ? carried.message + ' Reload the page and try again.'
      : carried.message;
    return false;
  }

  /**
   * Puts a refused write on a new branch and opens a pull request for it.
   *
   * A protected branch is the normal state of the branch a design doc actually
   * lives on, so refusing outright would make the extension useless exactly
   * where it is most wanted. The page stays where it is, since the commit is
   * now somewhere else; the panel shows the link.
   */
  async function commitToBranch() {
    const blocked = state && state.blockedWrite;
    if (!blocked) return;

    const branch = 'mdc-comments-' + MDCCodec.newID();
    const where = state.location;

    state.busy = 'Creating a branch and a pull request...';
    state.error = null;
    MDCPanel.render(state);

    try {
      await send({
        type: 'createBranch',
        owner: where.owner,
        repo: where.repo,
        from: where.ref,
        branch: branch
      });

      // The branch starts at the same commit, so the blob sha still matches and
      // the same optimistic concurrency check applies.
      await send({
        type: 'putFile',
        owner: where.owner,
        repo: where.repo,
        path: where.path,
        branch: branch,
        text: blocked.text,
        sha: state.sha,
        message: blocked.message
      });

      const pull = await send({
        type: 'createPullRequest',
        owner: where.owner,
        repo: where.repo,
        title: blocked.message,
        head: branch,
        base: where.ref,
        body: 'Comments on `' + where.path + '`, added with Markdown Comments.'
      });

      state.blockedWrite = null;
      state.pullRequest = pull;
      state.notice = null;
    } catch (error) {
      state.error = error.message;
    }

    state.busy = null;
    refresh();
  }

  // MARK: - Keeping the page honest after a write

  /**
   * The rendered document is GitHub's, produced before the commit, so after a
   * write its footnote layer describes the file as it was. Nothing here can
   * re-render it.
   *
   * What it can do is stop showing a layer it knows is wrong. The panel is the
   * live copy, and the superscripts and footnote list are already hidden while
   * it is open, so a stale layer is invisible during normal use anyway. Marking
   * the render stale keeps it hidden once the panel is closed too, rather than
   * revealing a footnote list missing the comment just added, or still showing
   * one just deleted. The next ordinary page load renders it correctly.
   *
   * This replaces reloading the page on every write, which was accurate and
   * unbearable: a flash and a panel that disappeared and came back each time
   * someone replied.
   */
  function markRenderStale() {
    if (state) state.renderStale = true;
  }

  async function submitDraft(text) {
    const draft = state && state.draft;
    if (!draft) return;

    const ok = await commit(function (next) {
      // Offsets are measured against the body this mutation is given, not the
      // one the selection was made in, so re-applying onto a newer version of
      // the file anchors to the phrase rather than to a stale offset.
      const span = MDCSourceMap.findSourceSpan(next.body, draft.anchor, draft.ordinal);
      if (span.error) throw new Error(span.error);
      next.body = MDCCodec.insertAnchor(next.body, draft.id, span.start, span.end);
      next.threads = next.threads.concat([{
        id: draft.id,
        status: 'open',
        anchor: draft.anchor,
        isOrphaned: false,
        replies: [{ author: state.author, date: new Date(), text: text }]
      }]);
    }, 'Comment on ' + state.location.path);

    if (!ok) return refresh();
    state.draft = null;
    // The page was rendered before this comment existed, so there is no
    // footnote reference to walk back from. The selection range is the only
    // thing that knows where the phrase is until the page is loaded again.
    if (draft.range) state.overrides.set(draft.id, draft.range);
    state.selectedID = draft.id;
    markRenderStale();
    refresh();
  }

  async function addReply(id, text) {
    const ok = await commit(function (next) {
      const thread = next.threads.find(function (t) { return t.id === id; });
      if (!thread) return;
      thread.replies.push({ author: state.author, date: new Date(), text: text });
      if (thread.status === 'resolved') thread.status = 'open';
    }, 'Comment on ' + state.location.path);
    if (!ok) return refresh();
    state.selectedID = id;
    markRenderStale();
    refresh();
  }

  async function setStatus(id, status) {
    const ok = await commit(function (next) {
      const thread = next.threads.find(function (t) { return t.id === id; });
      if (thread) thread.status = status;
    }, (status === 'resolved' ? 'Resolve comment on ' : 'Reopen comment on ') + state.location.path);
    if (!ok) return refresh();
    state.selectedID = id;
    markRenderStale();
    refresh();
  }

  async function deleteThread(id) {
    const thread = state.threads.find(function (t) { return t.id === id; });
    const count = thread ? thread.replies.length : 0;
    // Deleting pushes a commit that removes the thread from the file for
    // everyone, so make it a deliberate choice.
    if (!window.confirm(
      'Delete this comment thread and its ' + count + (count === 1 ? ' reply?' : ' replies?') +
      '\n\nThis commits the removal to ' + state.location.path + '.'
    )) return;

    const ok = await commit(function (next) {
      next.threads = next.threads.filter(function (t) { return t.id !== id; });
    }, 'Delete comment on ' + state.location.path);
    if (!ok) return refresh();
    state.overrides.delete(id);
    if (state.selectedID === id) state.selectedID = null;
    markRenderStale();
    refresh();
  }

  /**
   * Writes an orphaned thread back onto the passage it seems to have followed.
   * Only ever reached from the panel's offer: the match is a guess, and a
   * comment pointing at the wrong words is worse than one pointing at nothing.
   */
  async function reanchorThread(id) {
    const candidate = state && state.candidates.get(id);
    if (!candidate) return;

    const ok = await commit(function (next) {
      next.body = MDCCodec.insertAnchor(next.body, id, candidate.start, candidate.end);
      const thread = next.threads.find(function (t) { return t.id === id; });
      if (thread) thread.anchor = candidate.text;
    }, 'Re-anchor comment on ' + state.location.path);

    if (!ok) return refresh();
    state.selectedID = id;
    markRenderStale();
    refresh();
  }

  function dismissReanchor(id) {
    if (!state) return;
    state.dismissed.add(id);
    state.candidates.delete(id);
    refresh();
  }

  // MARK: - Creating a comment from a selection

  function beginComment() {
    const root = markdownBody();
    const selection = window.getSelection();
    if (!state || !root) return;

    if (!state.canWrite) {
      if (!state.hasToken) {
        state.error = 'Add a personal access token in the extension options to post comments.';
      } else if (state.authError) {
        state.error = 'Token is saved but GitHub would not confirm the account: ' + state.authError;
      } else if (SHA_REF.test(state.location.ref)) {
        state.error = 'This is a commit SHA, not a branch. Open the file on a branch to comment.';
      } else {
        state.error = 'Cannot write to this file with the saved token.';
      }
      setPanelOpen(true, true);
      MDCPanel.render(state);
      return;
    }
    if (!selection || !selection.rangeCount || selection.isCollapsed) return;

    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer)) return;

    const text = MDCAnchor.rangeText(range);
    if (!text) return;

    const ordinal = MDCSourceMap.selectionOrdinal(root, range, text);
    const span = MDCSourceMap.findSourceSpan(state.body, text, ordinal);

    setPanelOpen(true, true);
    if (span.error) {
      state.error = span.error;
      state.draft = null;
      refresh();
      return;
    }

    state.error = null;
    state.selectedID = null;
    state.draft = {
      id: MDCCodec.newID(),
      anchor: text,
      ordinal: ordinal,
      start: span.start,
      end: span.end,
      range: range.cloneRange()
    };
    refresh();
  }

  function ensureSelectionButton() {
    if (selectionButton) return selectionButton;
    selectionButton = document.createElement('button');
    selectionButton.className = 'mdc-selection-button';
    selectionButton.setAttribute('data-mdc-ui', 'selection');
    selectionButton.textContent = 'Comment';
    selectionButton.hidden = true;
    // mousedown would collapse the selection before the click lands.
    selectionButton.addEventListener('mousedown', function (event) { event.preventDefault(); });
    selectionButton.addEventListener('click', function () {
      selectionButton.hidden = true;
      beginComment();
    });
    document.body.appendChild(selectionButton);
    return selectionButton;
  }

  function updateSelectionButton() {
    // Shown even without a token: clicking explains what is missing, which is
    // more use than a button that never appears.
    if (!state) return;
    const button = ensureSelectionButton();
    const root = markdownBody();
    const selection = window.getSelection();

    if (!root || !selection || !selection.rangeCount || selection.isCollapsed) {
      button.hidden = true;
      return;
    }
    const range = selection.getRangeAt(0);
    if (!root.contains(range.commonAncestorContainer) || !range.toString().trim()) {
      button.hidden = true;
      return;
    }
    const rect = range.getBoundingClientRect();
    button.hidden = false;
    button.style.top = (window.scrollY + rect.bottom + 6) + 'px';
    button.style.left = (window.scrollX + rect.left) + 'px';
  }

  // MARK: - Lifecycle

  let booting = false;

  /** Mounts the panel in an error state so the failure is visible and actionable. */
  function showFailure(where, message) {
    state = {
      location: where,
      sha: null,
      body: '',
      threads: [],
      entries: [],
      overrides: new Map(),
      renderStale: false,
      selectedID: null,
      draft: null,
      showResolved: false,
      candidates: new Map(),
      dismissed: new Set(),
      blockedWrite: null,
      pullRequest: null,
      busy: null,
      notice: null,
      // describeFailure in the service worker already tailors this to whether
      // a token is present, so it is shown as-is.
      error: message,
      author: null,
      canWrite: false,
      // Without this the failed state would sit in `state` forever and block
      // boot() from ever retrying, so adding a token would not repair the tab.
      failed: true
    };
    MDCPanel.mount({
      onOpenOptions: function () { send({ type: 'openOptions' }).catch(function () {}); },
      onRetry: retry,
      // Especially here. A failed load is exactly when someone wants to know
      // what the extension could see.
      onDiagnostics: diagnostics
    });
    MDCPanel.render(state);
  }

  function retry() {
    teardown();
    boot();
  }

  // MARK: - Showing and hiding

  const PANEL_WIDTH = 340;

  /**
   * Shifts the page rather than covering it. GitHub's layout is fluid, so
   * a margin on the root element narrows the content and leaves the fixed
   * panel flush against the viewport edge.
   */
  function applyLayoutShift(open) {
    const root = document.documentElement;
    root.style.setProperty('--mdc-panel-width', PANEL_WIDTH + 'px');
    if (open) root.style.setProperty('margin-right', PANEL_WIDTH + 'px', 'important');
    else root.style.removeProperty('margin-right');
  }

  function setPanelOpen(open, persist) {
    // `persist` marks the changes a person asked for, which are the only ones
    // that should move focus.
    MDCPanel.setOpen(open, !!persist);
    applyLayoutShift(open);
    applyPlumbingVisibility(open);
    if (persist !== false) {
      try { chrome.storage.local.set({ panelOpen: !!open }); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Hides the footnote superscripts and the footnote list while the panel is
   * presenting the same comments, so the document reads as prose.
   *
   * Whether the panel is open is the whole condition, so the document does not
   * reflow while it is. Nothing about which threads the panel happens to be
   * showing belongs here: making the superscripts come and go as a disclosure
   * is expanded moves the prose under the reader for no reason they can see.
   * Making sure the panel has something to show is done where that decision
   * lives, by opening the resolved list when there is nothing else in it.
   *
   * A load failure still shows the plumbing, since a panel with nothing in it
   * leaves GitHub's own rendering as the only way to read the discussion. Thread
   * count is deliberately not part of this either: a document with none has no
   * plumbing for the rules to match, and keying on the count would make deleting
   * the last comment reveal the stale footnote of the comment just deleted,
   * since the page still shows the pre-commit render.
   */
  function applyPlumbingVisibility(open) {
    const hide = !!state && !state.failed && (!!open || state.renderStale);
    // Re-tagged here rather than only on refresh: the class sits on GitHub's
    // own elements, so a re-render drops it while this one stays on <html>.
    const root = hide ? markdownBody() : null;
    if (root) MDCAnchor.markGeneratedRegion(root);
    document.documentElement.classList.toggle('mdc-hide-plumbing', hide);
  }

  function togglePanel() {
    if (!state) return;
    setPanelOpen(!MDCPanel.isOpen(), true);
  }

  async function storedPanelPreference() {
    try {
      const stored = await chrome.storage.local.get('panelOpen');
      return typeof stored.panelOpen === 'boolean' ? stored.panelOpen : null;
    } catch (e) {
      return null;
    }
  }

  // MARK: - Display names

  /**
   * The file always stores the GitHub handle, which is what makes the footnote
   * render as a real profile link. Names are looked up only for the panel.
   */
  async function loadProfiles() {
    if (!state) return;
    const logins = [];
    for (const thread of state.threads) {
      for (const reply of thread.replies) {
        if (reply.author && logins.indexOf(reply.author) === -1) logins.push(reply.author);
      }
    }
    if (state.author && logins.indexOf(state.author) === -1) logins.push(state.author);
    if (!logins.length) return;

    try {
      const profiles = await send({ type: 'getProfiles', logins: logins });
      if (!state) return;
      state.profiles = Object.assign({}, state.profiles, profiles);
      refresh();
    } catch (error) {
      // Names are cosmetic; the handle is always shown as a fallback.
    }
  }

  async function boot() {
    // A failed state is not a loaded state: it must not block a later retry.
    if (booting || (state && !state.failed)) return;
    if (state && state.failed) teardown();
    const where = parseLocation();
    if (!where) return;
    const root = markdownBody();
    if (!root) return; // rendered body not in the DOM yet; the poller retries
    booting = true;
    try {
      await load(where, root);
    } finally {
      booting = false;
    }
  }

  async function load(where, root) {

    let tokenState = { hasToken: false };
    try {
      tokenState = await send({ type: 'hasToken' });
    } catch (e) {
      return; // extension context gone
    }

    let file;
    try {
      file = where.kind === 'readme'
        ? await send({ type: 'getReadme', owner: where.owner, repo: where.repo, dir: where.dir, ref: where.ref })
        : await send({ type: 'getFile', owner: where.owner, repo: where.repo, path: where.path, ref: where.ref });
    } catch (error) {
      // A repository with no README is ordinary, not a problem worth reporting.
      // A .md file the user explicitly opened failing to load is worth saying.
      if (where.kind === 'readme') return;
      // Say so rather than disappearing. A silent failure here is
      // indistinguishable from the extension not being installed.
      showFailure(where, error.message);
      return;
    }

    // A README's real filename and ref come back from the API, not the URL.
    if (where.kind === 'readme') {
      where = Object.assign({}, where, { path: file.path, ref: file.ref || where.ref });
    }

    const parsed = MDCCodec.split(file.text);
    let author = null;
    let authError = null;
    if (tokenState.hasToken) {
      try {
        author = (await send({ type: 'getUser' })).login || null;
        if (!author) authError = 'GitHub returned no login for this token.';
      } catch (error) {
        // Swallowing this produced a misleading "add a token" message when a
        // token was in fact present but /user had failed.
        authError = error.message;
      }
    }

    state = {
      location: where,
      sha: file.sha,
      body: parsed.body,
      threads: parsed.threads,
      entries: [],
      overrides: new Map(),
      renderStale: false,
      selectedID: null,
      draft: null,
      // A file whose discussion is entirely resolved opens with it shown. The
      // alternative is a panel holding only a "2 resolved" button while the
      // document's own copy of those comments is hidden behind it.
      showResolved: parsed.threads.length > 0 &&
        parsed.threads.every(function (t) { return t.status === 'resolved'; }),
      candidates: new Map(),
      dismissed: new Set(),
      blockedWrite: null,
      pullRequest: null,
      busy: null,
      error: null,
      notice: null,
      author: author,
      hasToken: !!tokenState.hasToken,
      authError: authError,
      failed: false,
      profiles: {},
      // Writing to a detached commit is not a thing; require a branch.
      canWrite: !!(tokenState.hasToken && author) && !SHA_REF.test(where.ref) && !!where.ref
    };

    findReanchorCandidates();

    console.info('[mdc-comments] ready', {
      file: where.owner + '/' + where.repo + '@' + where.ref + ':' + where.path,
      threads: state.threads.length,
      hasToken: state.hasToken,
      author: state.author,
      authError: state.authError,
      canWrite: state.canWrite
    });

    MDCPanel.mount({
      onSelect: selectThread,
      onReply: addReply,
      onSetStatus: setStatus,
      onDelete: deleteThread,
      onSubmitDraft: submitDraft,
      onCancelDraft: function () {
        state.draft = null;
        refresh();
      },
      onOpenOptions: function () { send({ type: 'openOptions' }).catch(function () {}); },
      onRetry: retry,
      onSetOpen: setPanelOpen,
      onReanchor: reanchorThread,
      onCommitToBranch: commitToBranch,
      onDiagnostics: diagnostics,
      onDismissReanchor: dismissReanchor
    });

    // Remembered preference wins; otherwise open when there is something to see.
    const preference = await storedPanelPreference();
    setPanelOpen(preference === null ? state.threads.length > 0 : preference, false);
    refresh();
    loadProfiles();
    startPolling();
  }

  // MARK: - Telling you what broke

  /**
   * What the extension can and cannot see right now.
   *
   * This exists because the way this fails is silent. It reads a page someone
   * else owns, and when GitHub changes that page the highlights simply stop
   * appearing, which looks exactly like not having installed anything. These
   * are the observations that separate those two, in a form that can be pasted
   * into a bug report.
   */
  function diagnostics() {
    const root = markdownBody();
    const manifest = chrome.runtime.getManifest ? chrome.runtime.getManifest() : {};
    const where = state && state.location;
    const entries = (state && state.entries) || [];
    const orphans = entries.filter(function (e) { return e.thread.isOrphaned; }).length;
    const anchored = entries.length - orphans;
    const located = entries.filter(function (e) { return e.range; }).length;
    const references = root ? root.querySelectorAll('[id^="user-content-fnref-mdc-"]').length : 0;

    return [
      { label: 'Extension', value: manifest.version || 'unknown' },
      { label: 'File format', value: 'v' + MDCCodec.FORMAT_VERSION },
      {
        label: 'Page',
        value: where ? where.kind + ' ' + where.owner + '/' + where.repo + '@' + where.ref : 'not a supported page',
        ok: !!where
      },
      { label: 'File', value: where ? where.path : '-', ok: !!(where && where.path) },
      { label: 'Rendered body found', value: root ? 'yes' : 'no', ok: !!root },
      { label: 'Highlight API', value: CSS && CSS.highlights ? 'available' : 'missing', ok: !!(CSS && CSS.highlights) },
      { label: 'Threads in file', value: String(entries.length) },
      {
        label: 'Anchored threads highlighted',
        value: located + ' of ' + anchored,
        // The one that catches a GitHub change: the file says these threads are
        // anchored, and the page cannot find where.
        ok: located === anchored
      },
      {
        label: 'Footnote references in page',
        value: String(references),
        ok: references > 0 || anchored === 0
      },
      { label: 'Orphaned threads', value: String(orphans) },
      { label: 'Re-anchor candidates', value: String(state ? state.candidates.size : 0) },
      { label: 'Token saved', value: state && state.hasToken ? 'yes' : 'no', ok: !!(state && state.hasToken) },
      { label: 'Can write here', value: state && state.canWrite ? 'yes' : 'no', ok: !!(state && state.canWrite) },
      { label: 'Last error', value: (state && state.error) || 'none', ok: !(state && state.error) }
    ];
  }

  function teardown() {
    stopPolling();
    MDCAnchor.clearHighlights();
    MDCPanel.destroy();
    applyLayoutShift(false);
    document.documentElement.classList.remove('mdc-hide-plumbing');
    if (selectionButton) selectionButton.hidden = true;
    state = null;
  }

  // MARK: - Watching for comments left by other people

  const POLL_INTERVAL = 60000;
  let pollTimer = null;

  function startPolling() {
    stopPolling();
    if (!state) return;
    pollTimer = setInterval(pollForChanges, POLL_INTERVAL);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  /** True when the user has something half-typed that a refresh would discard. */
  function hasUnsentInput() {
    if (!state) return false;
    if (state.draft) return true;
    if (state.busy) return true;
    const fields = document.querySelectorAll('.mdc-panel textarea');
    for (const field of fields) {
      if (field.value && field.value.trim()) return true;
    }
    return false;
  }

  async function pollForChanges() {
    if (!state || state.failed || document.hidden) return;

    let file;
    try {
      file = await send({
        type: 'getFile',
        owner: state.location.owner,
        repo: state.location.repo,
        path: state.location.path,
        ref: state.location.ref,
        conditional: true
      });
    } catch (error) {
      return; // transient; the next tick tries again
    }
    if (!state || file.notModified || file.sha === state.sha) return;

    const parsed = MDCCodec.split(file.text);
    const known = new Set(state.threads.map(function (t) { return t.id; }));
    const arrived = parsed.threads.filter(function (t) { return !known.has(t.id); }).length;

    if (hasUnsentInput()) {
      // Never discard something the user is in the middle of writing.
      state.notice = arrived
        ? arrived + (arrived === 1 ? ' new comment' : ' new comments') +
          ' arrived. Finish or cancel what you are writing to load them.'
        : 'This file changed on GitHub. Finish or cancel what you are writing to load it.';
      MDCPanel.render(state);
      return;
    }

    state.sha = file.sha;
    state.body = parsed.body;
    state.threads = parsed.threads;
    state.overrides = new Map();
    findReanchorCandidates();
    if (state.selectedID && !parsed.threads.some(function (t) { return t.id === state.selectedID; })) {
      state.selectedID = null;
    }
    state.notice = arrived
      ? arrived + (arrived === 1 ? ' new comment' : ' new comments') + ' arrived.'
      : null;
    refresh();
    loadProfiles();
  }

  document.addEventListener('visibilitychange', function () {
    // Check straight away on return rather than waiting out the interval.
    if (!document.hidden && state) pollForChanges();
  });

  document.addEventListener('mouseup', function () {
    setTimeout(updateSelectionButton, 0);
  });

  document.addEventListener('click', function (event) {
    if (!state) return;
    if (event.target.closest && event.target.closest('[data-mdc-ui]')) return;
    const root = markdownBody();
    if (!root || !root.contains(event.target)) return;

    const id = MDCAnchor.threadAtPoint(state.entries, event.clientX, event.clientY);
    if (id) {
      setPanelOpen(true, true);
      selectThread(id);
    }
  });

  /** True while the keystroke belongs to something being typed into. */
  function isTyping(target) {
    if (!target) return false;
    if (target.isContentEditable) return true;
    const tag = target.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
  }

  /** Moves the selection along the panel's own order, wrapping at both ends. */
  function stepThread(delta) {
    const shown = state.entries.filter(function (entry) {
      return state.showResolved || entry.thread.status !== 'resolved';
    });
    if (!shown.length) return;
    const at = shown.findIndex(function (entry) { return entry.id === state.selectedID; });
    const next = at === -1
      ? (delta > 0 ? 0 : shown.length - 1)
      : (at + delta + shown.length) % shown.length;
    selectThread(shown[next].id);
  }

  document.addEventListener('keydown', function (event) {
    if (!state || !event.key) return;
    if (event.key === 'Escape' && state.draft) {
      state.draft = null;
      refresh();
    }
    // Cmd/Ctrl-Alt-M, matching the usual comment-on-selection shortcut.
    if ((event.metaKey || event.ctrlKey) && event.altKey && event.key.toLowerCase() === 'm') {
      event.preventDefault();
      beginComment();
      return;
    }

    // Single letters, so only while the panel is showing and nothing is being
    // typed into. GitHub has its own single-key shortcuts, hence preventDefault
    // on the ones taken here.
    if (!MDCPanel.isOpen() || isTyping(event.target)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === 'j' || event.key === 'k') {
      event.preventDefault();
      stepThread(event.key === 'j' ? 1 : -1);
      return;
    }
    if (event.key === 'r' && state.selectedID) {
      event.preventDefault();
      MDCPanel.focusReply(state.selectedID);
      return;
    }
    if (event.key === 'e' && state.selectedID) {
      const thread = state.threads.find(function (t) { return t.id === state.selectedID; });
      if (!thread || !state.canWrite) return;
      event.preventDefault();
      setStatus(thread.id, thread.status === 'resolved' ? 'open' : 'resolved');
    }
  });

  // The toolbar icon and the Alt+C command both route through here.
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== 'togglePanel') return;
    if (state) togglePanel();
  });

  // Saving a token in the options page should repair tabs that are already
  // open, rather than requiring a reload nobody knows to perform.
  if (chrome.storage && chrome.storage.onChanged) {
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area !== 'local' || !changes.token) return;
      retry();
    });
  }

  /**
   * GitHub navigates without a page load, and renders the blob body
   * asynchronously. Polling covers both without guessing at framework events.
   */
  setInterval(function () {
    const href = location.href;
    if (href !== lastHref) {
      lastHref = href;
      if (state) teardown();
      setTimeout(boot, 250);
      return;
    }
    if (!state && parseLocation() && markdownBody()) boot();
  }, 400);

  lastHref = location.href;
  boot();
})();

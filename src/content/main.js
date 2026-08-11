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
          if (!response.ok) return reject(new Error(response.error || 'Request failed.'));
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

  function buildEntries(root) {
    const entries = state.threads.map(function (thread) {
      let range = state.overrides.get(thread.id) || null;
      if (!range && !thread.isOrphaned) range = MDCAnchor.locate(root, thread);
      return { id: thread.id, thread: thread, range: range };
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
    MDCAnchor.markGeneratedRegion(root);
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

  async function commit(mutate, message) {
    if (!state || !state.canWrite) return false;

    const next = { body: state.body, threads: state.threads.map(cloneThread) };
    mutate(next);
    const text = MDCCodec.join(next.body, next.threads);

    state.busy = 'Saving to GitHub...';
    state.error = null;
    state.notice = null;
    MDCPanel.render(state);

    try {
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
      state.busy = null;
      return true;
    } catch (error) {
      state.busy = null;
      state.error = error.message.indexOf('changed on GitHub') !== -1
        ? error.message + ' Reload the page and try again.'
        : error.message;
      return false;
    }
  }

  async function submitDraft(text) {
    const draft = state && state.draft;
    if (!draft) return;

    const ok = await commit(function (next) {
      next.body = MDCCodec.insertAnchor(next.body, draft.id, draft.start, draft.end);
      next.threads = next.threads.concat([{
        id: draft.id,
        status: 'open',
        anchor: draft.anchor,
        isOrphaned: false,
        replies: [{ author: state.author, date: new Date(), text: text }]
      }]);
    }, 'Comment on ' + state.location.path);

    if (ok) {
      // The page still shows the pre-commit render, so there is no footnote
      // reference to anchor against yet. Keep the selection range until reload.
      if (draft.range) state.overrides.set(draft.id, draft.range);
      state.selectedID = draft.id;
      state.draft = null;
      state.notice = 'Comment committed. Reload to see it rendered as a footnote.';
    }
    refresh();
  }

  async function addReply(id, text) {
    const ok = await commit(function (next) {
      const thread = next.threads.find(function (t) { return t.id === id; });
      if (!thread) return;
      thread.replies.push({ author: state.author, date: new Date(), text: text });
      if (thread.status === 'resolved') thread.status = 'open';
    }, 'Comment on ' + state.location.path);
    if (ok) state.selectedID = id;
    refresh();
  }

  async function setStatus(id, status) {
    await commit(function (next) {
      const thread = next.threads.find(function (t) { return t.id === id; });
      if (thread) thread.status = status;
    }, (status === 'resolved' ? 'Resolve comment on ' : 'Reopen comment on ') + state.location.path);
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
    if (ok) {
      state.overrides.delete(id);
      if (state.selectedID === id) state.selectedID = null;
    }
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

    const text = MDCAnchor.normalizeWhitespace(range.toString());
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
      selectedID: null,
      draft: null,
      showResolved: false,
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
      onRetry: retry
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
    MDCPanel.setOpen(open);
    applyLayoutShift(open);
    applyPlumbingVisibility(open);
    if (persist !== false) {
      try { chrome.storage.local.set({ panelOpen: !!open }); } catch (e) { /* ignore */ }
    }
  }

  /**
   * Hides the footnote superscripts and the footnote list while the panel is
   * presenting the same comments, so the document reads as prose. Only done
   * once threads actually loaded: with nothing to show in their place, GitHub's
   * own rendering is the only way to read the discussion.
   */
  function applyPlumbingVisibility(open) {
    const hide = !!open && !!state && !state.failed && state.threads.length > 0;
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
      selectedID: null,
      draft: null,
      showResolved: false,
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
      onSetOpen: setPanelOpen
    });

    // Remembered preference wins; otherwise open when there is something to see.
    const preference = await storedPanelPreference();
    setPanelOpen(preference === null ? state.threads.length > 0 : preference, false);
    refresh();
    loadProfiles();
    startPolling();
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

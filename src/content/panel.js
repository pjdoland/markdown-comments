/**
 * The comments margin panel.
 *
 * Lives on document.body, outside GitHub's React tree, so plain DOM
 * manipulation is safe here. Everything is rebuilt on render; in-progress text
 * is preserved across renders by keying it to the thread id, and focus is
 * restored afterwards so typing is never interrupted.
 */
const MDCPanel = (function () {
  'use strict';

  let root = null;
  let toggle = null;
  let listEl = null;
  let bannerEl = null;
  let countEl = null;
  let handlers = {};
  let lastState = null;
  const pendingText = Object.create(null);

  /**
   * Panel timestamps, in the viewer's own locale and time zone. This is
   * deliberately different from the date written into the file, which is fixed
   * to en-US/UTC so that two people saving the same document produce identical
   * bytes. Here the reader is the only audience, so local time is correct.
   *
   * The year is dropped only within the current year, and the day only for
   * today, so a shortened form is never ambiguous about which one it means.
   * The full value, with time zone, is always available as a tooltip.
   */
  const TIME_ONLY = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
  const DAY_SHORT = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' });
  const DAY_WITH_YEAR = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const FULL_STAMP = new Intl.DateTimeFormat(undefined, { dateStyle: 'full', timeStyle: 'long' });

  function shortTimestamp(date) {
    const now = new Date();
    const sameYear = date.getFullYear() === now.getFullYear();
    const sameDay = sameYear &&
      date.getMonth() === now.getMonth() &&
      date.getDate() === now.getDate();

    if (sameDay) return TIME_ONLY.format(date);
    const day = (sameYear ? DAY_SHORT : DAY_WITH_YEAR).format(date);
    return day + ', ' + TIME_ONLY.format(date);
  }

  function fullTimestamp(date) {
    return FULL_STAMP.format(date);
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function mount(callbacks) {
    handlers = callbacks || {};
    if (root) return;

    root = el('div', 'mdc-panel');
    root.setAttribute('data-mdc-ui', 'panel');
    root.hidden = true;

    const header = el('div', 'mdc-header');
    header.appendChild(el('span', 'mdc-title', 'Comments'));
    countEl = el('span', 'mdc-count');
    countEl.hidden = true;
    header.appendChild(countEl);
    header.appendChild(el('div', 'mdc-spacer'));

    const close = el('button', 'mdc-icon-button', '×');
    close.title = 'Hide comments (Alt+C)';
    close.setAttribute('aria-label', 'Hide comments');
    close.addEventListener('click', function () { requestOpen(false); });
    header.appendChild(close);
    root.appendChild(header);

    bannerEl = el('div', 'mdc-banner');
    bannerEl.hidden = true;
    root.appendChild(bannerEl);

    listEl = el('div', 'mdc-list');
    root.appendChild(listEl);

    toggle = el('button', 'mdc-toggle');
    toggle.setAttribute('data-mdc-ui', 'toggle');
    toggle.title = 'Show comments (Alt+C)';
    toggle.hidden = true;
    toggle.addEventListener('click', function () { requestOpen(true); });

    document.body.appendChild(root);
    document.body.appendChild(toggle);
  }

  /**
   * Visibility is owned by the caller, which also shifts the page layout and
   * remembers the preference, so the panel never flips itself.
   */
  function requestOpen(open) {
    if (handlers.onSetOpen) handlers.onSetOpen(open, true);
    else setOpen(open);
  }

  function destroy() {
    if (root) root.remove();
    if (toggle) toggle.remove();
    root = toggle = listEl = bannerEl = countEl = null;
    lastState = null;
    for (const key of Object.keys(pendingText)) delete pendingText[key];
  }

  function setOpen(open) {
    if (!root) return;
    root.hidden = !open;
    if (toggle) toggle.hidden = open;
    if (open && lastState) render(lastState);
  }

  function isOpen() {
    return !!root && !root.hidden;
  }

  /** Remembers which field had focus so a re-render does not steal the caret. */
  function captureFocus() {
    const active = document.activeElement;
    if (!active || !root || !root.contains(active)) return null;
    return {
      key: active.getAttribute('data-mdc-field'),
      start: active.selectionStart,
      end: active.selectionEnd
    };
  }

  function restoreFocus(snapshot) {
    if (!snapshot || !snapshot.key || !root) return;
    const field = root.querySelector('[data-mdc-field="' + CSS.escape(snapshot.key) + '"]');
    if (!field) return;
    field.focus();
    try { field.setSelectionRange(snapshot.start, snapshot.end); } catch (e) { /* not selectable */ }
  }

  function render(state) {
    lastState = state;
    if (!root) return;

    const focus = captureFocus();

    const openCount = state.threads.filter(function (t) { return t.status !== 'resolved'; }).length;
    countEl.hidden = openCount === 0;
    countEl.textContent = String(openCount);

    toggle.textContent = openCount ? 'Comments ' + openCount : 'Comments';
    // Always offer the toggle on a supported page. Hiding it when a file has no
    // comments left no way to tell the extension from a broken one.
    toggle.hidden = isOpen();

    renderBanner(state);

    listEl.textContent = '';

    if (state.draft) listEl.appendChild(draftCard(state.draft));

    const ordered = state.entries || [];
    const open = ordered.filter(function (e) { return e.thread.status !== 'resolved'; });
    const resolved = ordered.filter(function (e) { return e.thread.status === 'resolved'; });

    for (const entry of open) listEl.appendChild(threadCard(entry, state));

    if (resolved.length) {
      const header = el('button', 'mdc-button', resolved.length + ' resolved');
      header.style.alignSelf = 'flex-start';
      header.addEventListener('click', function () {
        state.showResolved = !state.showResolved;
        // Whether the resolved threads are on screen decides whether the
        // document's own copy of them can be hidden, so this goes back through
        // the host rather than re-rendering the panel on its own.
        if (handlers.onShowResolved) handlers.onShowResolved();
        else render(state);
      });
      listEl.appendChild(header);
      if (state.showResolved) {
        for (const entry of resolved) listEl.appendChild(threadCard(entry, state));
      }
    }

    if (!ordered.length && !state.draft && !state.error) {
      listEl.appendChild(el('div', 'mdc-empty',
        state.canWrite
          ? 'No comments on ' + (state.location ? state.location.path : 'this file') +
            ' yet.\n\nSelect some text in the document and a Comment button will appear.'
          : 'No comments yet. Add a token in the extension options to post one.'));
    }

    restoreFocus(focus);
  }

  function renderBanner(state) {
    bannerEl.textContent = '';
    bannerEl.hidden = true;
    bannerEl.className = 'mdc-banner';

    if (state.busy) {
      bannerEl.hidden = false;
      bannerEl.classList.add('mdc-busy');
      bannerEl.textContent = state.busy;
      return;
    }
    // A pull request is the outcome of a refused write, so it outranks the
    // error that produced it.
    if (state.pullRequest) {
      bannerEl.hidden = false;
      bannerEl.classList.add('mdc-info');
      bannerEl.appendChild(document.createTextNode('Committed to a branch. '));
      const link = document.createElement('a');
      link.textContent = 'Pull request #' + state.pullRequest.number;
      link.href = state.pullRequest.url;
      link.target = '_blank';
      link.rel = 'noopener noreferrer';
      bannerEl.appendChild(link);
      return;
    }
    if (state.error) {
      bannerEl.hidden = false;
      bannerEl.classList.add('mdc-error');
      bannerEl.appendChild(document.createTextNode(state.error + ' '));

      // The write was refused for a reason with a way around it, and the text
      // is still held, so offer the way around rather than only the failure.
      if (state.blockedWrite && handlers.onCommitToBranch) {
        const branch = document.createElement('a');
        branch.textContent = 'Commit to a branch and open a pull request';
        branch.addEventListener('click', function () { handlers.onCommitToBranch(); });
        bannerEl.appendChild(branch);
        return;
      }

      if (handlers.onOpenOptions) {
        const options = document.createElement('a');
        options.textContent = 'Options';
        options.addEventListener('click', function () { handlers.onOpenOptions(); });
        bannerEl.appendChild(options);
      }
      if (handlers.onRetry) {
        bannerEl.appendChild(document.createTextNode(' · '));
        const again = document.createElement('a');
        again.textContent = 'Retry';
        again.addEventListener('click', function () { handlers.onRetry(); });
        bannerEl.appendChild(again);
      }
      return;
    }
    if (state.notice) {
      bannerEl.hidden = false;
      bannerEl.classList.add('mdc-info');
      bannerEl.textContent = state.notice;
      return;
    }
    if (!state.canWrite) {
      bannerEl.hidden = false;
      bannerEl.classList.add('mdc-info');
      bannerEl.appendChild(document.createTextNode('Read only. '));
      const link = document.createElement('a');
      link.textContent = 'Add a token';
      link.addEventListener('click', function () {
        if (handlers.onOpenOptions) handlers.onOpenOptions();
      });
      bannerEl.appendChild(link);
      bannerEl.appendChild(document.createTextNode(' to post comments.'));
    }
  }

  function quote(text, isOrphan) {
    const wrap = el('div', 'mdc-quote' + (isOrphan ? ' mdc-orphan' : ''));
    wrap.appendChild(el('div', 'mdc-quote-bar'));
    const body = el('div', 'mdc-quote-text', text);
    if (isOrphan) {
      body.appendChild(el('span', 'mdc-orphan-note', 'This text is no longer in the document'));
    }
    wrap.appendChild(body);
    return wrap;
  }

  function draftCard(draft) {
    const card = el('div', 'mdc-card mdc-draft');
    card.appendChild(quote(draft.anchor, false));

    const input = el('textarea', 'mdc-input');
    input.placeholder = 'Add a comment...';
    input.setAttribute('data-mdc-field', 'draft');
    input.value = pendingText.draft || '';
    input.addEventListener('input', function () { pendingText.draft = input.value; });
    input.addEventListener('keydown', function (event) {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submitDraft(input.value);
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        cancelDraft();
      }
    });
    card.appendChild(input);

    const actions = el('div', 'mdc-actions');
    actions.appendChild(el('div', 'mdc-spacer'));

    const cancel = el('button', 'mdc-button', 'Cancel');
    cancel.addEventListener('click', cancelDraft);
    actions.appendChild(cancel);

    const submit = el('button', 'mdc-button mdc-primary', 'Comment');
    submit.addEventListener('click', function () { submitDraft(input.value); });
    actions.appendChild(submit);

    card.appendChild(actions);
    setTimeout(function () { input.focus(); }, 0);
    return card;
  }

  function submitDraft(text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    delete pendingText.draft;
    if (handlers.onSubmitDraft) handlers.onSubmitDraft(trimmed);
  }

  function cancelDraft() {
    delete pendingText.draft;
    if (handlers.onCancelDraft) handlers.onCancelDraft();
  }

  /**
   * The offer to put an orphaned thread back on the passage it looks like it
   * followed. Shown rather than acted on: re-anchoring is a commit, and the
   * match is a guess about someone else's edit.
   */
  function reanchorOffer(id, candidate) {
    const wrap = el('div', 'mdc-reanchor');
    wrap.appendChild(el('div', 'mdc-reanchor-head',
      'Possibly moved here (' + Math.round(candidate.score * 100) + '% match)'));
    wrap.appendChild(el('div', 'mdc-reanchor-text', candidate.text));

    const actions = el('div', 'mdc-actions');
    actions.appendChild(el('div', 'mdc-spacer'));

    const dismiss = el('button', 'mdc-button', 'Dismiss');
    dismiss.addEventListener('click', function (event) {
      event.stopPropagation();
      if (handlers.onDismissReanchor) handlers.onDismissReanchor(id);
    });
    actions.appendChild(dismiss);

    const accept = el('button', 'mdc-button mdc-primary', 'Re-anchor');
    accept.addEventListener('click', function (event) {
      event.stopPropagation();
      if (handlers.onReanchor) handlers.onReanchor(id);
    });
    actions.appendChild(accept);

    wrap.appendChild(actions);
    return wrap;
  }

  function threadCard(entry, state) {
    const thread = entry.thread;
    const selected = state.selectedID === thread.id;
    const card = el('div', 'mdc-card' +
      (selected ? ' mdc-selected' : '') +
      (thread.status === 'resolved' ? ' mdc-done' : ''));

    card.appendChild(quote(thread.anchor, thread.isOrphaned || !entry.range));
    if (entry.candidate && state.canWrite) {
      card.appendChild(reanchorOffer(thread.id, entry.candidate));
    }

    for (const reply of thread.replies) {
      card.appendChild(replyBlock(reply, state));
    }

    if (selected && state.canWrite) {
      const compose = el('div', 'mdc-compose');
      const key = 'reply:' + thread.id;
      const input = el('textarea', 'mdc-input');
      input.placeholder = thread.status === 'resolved' ? 'Reopen with a reply...' : 'Reply...';
      input.setAttribute('data-mdc-field', key);
      input.value = pendingText[key] || '';
      input.addEventListener('input', function () { pendingText[key] = input.value; });
      input.addEventListener('click', function (event) { event.stopPropagation(); });
      input.addEventListener('keydown', function (event) {
        if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
          event.preventDefault();
          sendReply(thread.id, input.value);
        }
      });
      compose.appendChild(input);

      const actions = el('div', 'mdc-actions');

      const reply = el('button', 'mdc-button mdc-primary', 'Reply');
      reply.addEventListener('click', function (event) {
        event.stopPropagation();
        sendReply(thread.id, input.value);
      });
      actions.appendChild(reply);

      const resolve = el('button', 'mdc-button', thread.status === 'resolved' ? 'Reopen' : 'Resolve');
      resolve.addEventListener('click', function (event) {
        event.stopPropagation();
        if (handlers.onSetStatus) {
          handlers.onSetStatus(thread.id, thread.status === 'resolved' ? 'open' : 'resolved');
        }
      });
      actions.appendChild(resolve);

      actions.appendChild(el('div', 'mdc-spacer'));

      const remove = el('button', 'mdc-button mdc-danger', 'Delete');
      remove.addEventListener('click', function (event) {
        event.stopPropagation();
        if (handlers.onDelete) handlers.onDelete(thread.id);
      });
      actions.appendChild(remove);

      compose.appendChild(actions);
      card.appendChild(compose);
    }

    card.addEventListener('click', function () {
      if (handlers.onSelect) handlers.onSelect(selected ? null : thread.id);
    });
    return card;
  }

  /**
   * Shows the person's display name, falling back to the handle until the
   * profile lookup lands (or if they have no name set). The handle stays
   * available as a tooltip, and is what the file itself always stores.
   */
  function replyBlock(reply, state) {
    const profile = (state.profiles || {})[reply.author] || null;
    const block = el('div', 'mdc-reply');
    const head = el('div', 'mdc-reply-head');

    // The URL comes from GitHub's user API, but this is the one attribute in
    // the panel built from a response rather than typed by us, so it is checked
    // rather than trusted. No avatar is a better outcome than an unknown one.
    const avatarURL = profile && /^https:\/\//.test(String(profile.avatar || ''))
      ? profile.avatar
      : null;
    if (avatarURL) {
      const avatar = document.createElement('img');
      avatar.className = 'mdc-avatar';
      avatar.src = avatarURL + (avatarURL.indexOf('?') === -1 ? '?s=48' : '&s=48');
      avatar.alt = '';
      avatar.addEventListener('error', function () { avatar.remove(); });
      head.appendChild(avatar);
    }

    const name = el('span', 'mdc-author', profile && profile.name ? profile.name : '@' + reply.author);
    name.title = '@' + reply.author;
    head.appendChild(name);

    const stamp = el('span', 'mdc-date', shortTimestamp(reply.date));
    stamp.title = fullTimestamp(reply.date);
    head.appendChild(stamp);

    block.appendChild(head);

    // Replies are written and stored as Markdown, and GitHub renders them as
    // Markdown in the footnote. Showing them flat here was the odd one out.
    const body = el('div', 'mdc-text');
    body.appendChild(MDCMarkdown.render(reply.text));
    block.appendChild(body);
    return block;
  }

  function sendReply(id, text) {
    const trimmed = String(text || '').trim();
    if (!trimmed) return;
    delete pendingText['reply:' + id];
    if (handlers.onReply) handlers.onReply(id, trimmed);
  }

  function scrollCardIntoView(id) {
    if (!root || root.hidden) return;
    const cards = listEl.querySelectorAll('.mdc-card.mdc-selected');
    if (cards.length) cards[0].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  return {
    mount: mount,
    destroy: destroy,
    render: render,
    setOpen: setOpen,
    isOpen: isOpen,
    scrollCardIntoView: scrollCardIntoView
  };
})();

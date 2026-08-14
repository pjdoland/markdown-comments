/**
 * GitHub API access, kept in the service worker.
 *
 * Content scripts could fetch directly, but then the personal access token
 * would have to live in a script injected into github.com. Doing it here keeps
 * the token in extension storage and out of any page context, and host
 * permissions apply so there is no CORS negotiation.
 */
'use strict';

const API_ROOT = 'https://api.github.com';

async function storedToken() {
  const stored = await chrome.storage.local.get('token');
  return stored.token || null;
}

function decodeBase64(value) {
  const binary = atob(String(value || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function encodeBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * Whether a write was refused because the branch will not take direct pushes.
 *
 * GitHub says this several ways and with several statuses depending on which
 * rule caught it, so it is recognised by what the message is about rather than
 * by a code. The caller offers a branch and a pull request instead of showing
 * a dead end, so a false positive costs an offer, not a failed write.
 */
function isBranchProtected(status, body) {
  if (status !== 403 && status !== 409 && status !== 422) return false;
  const message = String((body && body.message) || '').toLowerCase();
  return message.includes('protected branch') ||
         message.includes('branch protection') ||
         message.includes('pull request') ||
         message.includes('required status check');
}

/** Turns an API failure into something a person can act on. */
function describeFailure(status, body, authenticated) {
  const detail = (body && body.message) || 'HTTP ' + status;
  if (isBranchProtected(status, body)) {
    return 'This branch does not take direct commits. (' + detail + ')';
  }
  switch (status) {
    case 401:
      return 'GitHub rejected the token. Open the extension options and paste a current one.';
    case 403:
      return authenticated
        ? 'Token lacks permission for this repository. It needs Contents: read and write. (' + detail + ')'
        : 'Rate limited by GitHub. Add a personal access token in the extension options.';
    case 404:
      return authenticated
        ? 'File not found, or the token has no access to this repository.'
        : 'File not found. Private repositories need a token, set in the extension options.';
    case 409:
      return 'The file changed on GitHub since it was loaded.';
    case 422:
      return 'GitHub refused the write: ' + detail;
    default:
      return detail;
  }
}

async function requestAPI(path, options) {
  const settings = options || {};
  const token = await storedToken();
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28'
  };
  if (token) headers.Authorization = 'Bearer ' + token;
  if (settings.body) headers['Content-Type'] = 'application/json';
  if (settings.etag) headers['If-None-Match'] = settings.etag;

  const response = await fetch(API_ROOT + path, {
    method: settings.method,
    body: settings.body,
    headers: headers,
    // The contents API is served with `cache-control: max-age=60`, so without
    // this the browser answers a read from its own cache for a minute after a
    // write. That returns the file as it was before the commit, along with the
    // blob sha it had then, and the next write fails as a stale update against
    // a file nobody else touched. Freshness here is decided by the ETag we
    // manage below, not by the HTTP cache.
    cache: 'no-store'
  });

  // A conditional request that comes back 304 does not count against the
  // rate limit, which is what makes polling cheap enough to do on a timer.
  if (response.status === 304) return { notModified: true, response: response };

  const text = await response.text();
  let payload = null;
  if (text) {
    try { payload = JSON.parse(text); } catch (e) { payload = null; }
  }

  if (!response.ok) {
    const error = new Error(describeFailure(response.status, payload, !!token));
    error.status = response.status;
    // A flag rather than prose, so the content script does not have to match on
    // wording that GitHub is free to change.
    error.protectedBranch = isBranchProtected(response.status, payload);
    throw error;
  }
  return { payload: payload, response: response };
}

async function callAPI(path, options) {
  const result = await requestAPI(path, options);
  return result.payload;
}

// ETags per file, so the poll only transfers a body when something changed.
const fileETags = new Map();

function encodePath(path) {
  return path.split('/').map(encodeURIComponent).join('/');
}

/**
 * Recovers the ref a contents response came from. Branch names may contain
 * slashes, so the known file path is stripped off the end rather than assuming
 * the ref is a single segment.
 */
function refFromContentURLs(data, owner, repo) {
  const path = data.path || '';
  const candidates = [
    [data.download_url, 'https://raw.githubusercontent.com/' + owner + '/' + repo + '/'],
    [data.html_url, 'https://github.com/' + owner + '/' + repo + '/blob/']
  ];
  for (const candidate of candidates) {
    const url = candidate[0];
    const prefix = candidate[1];
    if (typeof url !== 'string' || url.indexOf(prefix) !== 0) continue;
    let tail = url.slice(prefix.length);
    if (path && tail.length > path.length && tail.slice(-(path.length + 1)) === '/' + path) {
      tail = tail.slice(0, -(path.length + 1));
    }
    if (tail) return decodeURIComponent(tail);
  }
  return null;
}

// Display names are cosmetic, so they are cached hard and failures are cached
// too. The file always stores the handle; only the panel shows the name.
const PROFILE_TTL = 7 * 24 * 60 * 60 * 1000;
const profileMemo = new Map();

const handlers = {
  async getFile(request) {
    const query = request.ref ? '?ref=' + encodeURIComponent(request.ref) : '';
    const path = '/repos/' + request.owner + '/' + request.repo +
                 '/contents/' + encodePath(request.path) + query;
    const key = [request.owner, request.repo, request.ref, request.path].join(' ');

    const result = await requestAPI(path, {
      etag: request.conditional ? fileETags.get(key) : undefined
    });
    if (result.notModified) return { notModified: true };

    const data = result.payload;
    if (Array.isArray(data) || !data || typeof data.content !== 'string') {
      throw new Error('That path is not a file.');
    }
    const etag = result.response.headers.get('ETag');
    if (etag) fileETags.set(key, etag);
    else fileETags.delete(key);

    return { text: decodeBase64(data.content), sha: data.sha };
  },

  /**
   * Writes the file back as a commit. The blob sha gives optimistic
   * concurrency: a stale write fails with 409 instead of silently clobbering
   * whatever someone else committed in the meantime.
   */
  async putFile(request) {
    const body = {
      message: request.message,
      content: encodeBase64(request.text),
      sha: request.sha
    };
    if (request.branch) body.branch = request.branch;

    const data = await callAPI(
      '/repos/' + request.owner + '/' + request.repo + '/contents/' + encodePath(request.path),
      { method: 'PUT', body: JSON.stringify(body) }
    );
    return { sha: data.content && data.content.sha, commit: data.commit && data.commit.sha };
  },

  /**
   * Branches `from` at its current head. Used when the branch someone is
   * reading will not take a direct commit, so the comment can go somewhere it
   * is allowed to go rather than nowhere.
   */
  async createBranch(request) {
    const repo = '/repos/' + request.owner + '/' + request.repo;
    const head = await callAPI(repo + '/git/ref/heads/' + encodePath(request.from));

    await callAPI(repo + '/git/refs', {
      method: 'POST',
      body: JSON.stringify({
        ref: 'refs/heads/' + request.branch,
        sha: head.object && head.object.sha
      })
    });
    return { branch: request.branch };
  },

  async createPullRequest(request) {
    const data = await callAPI('/repos/' + request.owner + '/' + request.repo + '/pulls', {
      method: 'POST',
      body: JSON.stringify({
        title: request.title,
        head: request.head,
        base: request.base,
        body: request.body || ''
      })
    });
    return { number: data.number, url: data.html_url };
  },

  /**
   * Fetches the README GitHub is showing for a repository or subdirectory,
   * which is what the repo home page and tree views render. The API reports the
   * real filename, so casing variants (README.md, readme.markdown) need no
   * guessing.
   */
  async getReadme(request) {
    const dir = request.dir ? '/' + encodePath(request.dir) : '';
    const query = request.ref ? '?ref=' + encodeURIComponent(request.ref) : '';
    const data = await callAPI(
      '/repos/' + request.owner + '/' + request.repo + '/readme' + dir + query
    );
    if (!data || typeof data.content !== 'string') throw new Error('No README here.');
    return {
      text: decodeBase64(data.content),
      sha: data.sha,
      path: data.path,
      ref: request.ref || refFromContentURLs(data, request.owner, request.repo)
    };
  },

  async getUser() {
    const token = await storedToken();
    if (!token) return { login: null };
    const data = await callAPI('/user');
    return { login: data.login, name: data.name || null, avatar: data.avatar_url || null };
  },

  /** Resolves handles to display names for the panel. Never affects the file. */
  async getProfiles(request) {
    const logins = Array.isArray(request.logins) ? request.logins : [];
    const stored = await chrome.storage.local.get('profiles');
    const cache = stored.profiles || {};
    const now = Date.now();
    const result = {};
    const missing = [];

    for (const login of logins) {
      const hit = profileMemo.get(login) || cache[login];
      if (hit && now - hit.at < PROFILE_TTL) {
        profileMemo.set(login, hit);
        result[login] = hit;
      } else if (missing.indexOf(login) === -1) {
        missing.push(login);
      }
    }

    for (const login of missing) {
      let entry;
      try {
        const data = await callAPI('/users/' + encodeURIComponent(login));
        entry = { login: login, name: data.name || null, avatar: data.avatar_url || null, at: now };
      } catch (error) {
        // A deleted or unreachable account should not retry on every page view.
        entry = { login: login, name: null, avatar: null, at: now };
      }
      profileMemo.set(login, entry);
      cache[login] = entry;
      result[login] = entry;
    }

    if (missing.length) await chrome.storage.local.set({ profiles: cache });
    return result;
  },

  async hasToken() {
    return { hasToken: !!(await storedToken()) };
  },

  /**
   * Verifies the saved token can actually reach a repository. A fine-grained
   * token is per-repository, so `GET /user` succeeding says nothing about
   * whether this repo is in its list, and a repo it cannot see returns 404.
   */
  async checkRepo(request) {
    const data = await callAPI('/repos/' + request.owner + '/' + request.repo);
    return {
      fullName: data.full_name,
      isPrivate: data.private,
      canPush: !!(data.permissions && data.permissions.push),
      defaultBranch: data.default_branch
    };
  },

  async openOptions() {
    // Content scripts cannot call this directly.
    await chrome.runtime.openOptionsPage();
    return {};
  },

  async validateToken(request) {
    const response = await fetch(API_ROOT + '/user', {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: 'Bearer ' + request.token,
        'X-GitHub-Api-Version': '2022-11-28'
      }
    });
    if (response.status === 401) throw new Error('GitHub returned 401. That token is not valid.');
    if (!response.ok) throw new Error('GitHub returned status ' + response.status + '.');
    const data = await response.json();
    return { login: data.login, avatarURL: data.avatar_url };
  }
};

/** Two obvious ways to show or hide the panel, besides the in-page button. */
async function togglePanelInActiveTab(tab) {
  const target = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!target || !target.id) return;
  try {
    await chrome.tabs.sendMessage(target.id, { type: 'togglePanel' });
  } catch (error) {
    // No content script on this page; nothing to toggle.
  }
}

chrome.action.onClicked.addListener(function (tab) { togglePanelInActiveTab(tab); });

// MARK: - Saying that setup is not finished

/**
 * An extension that needs a token before it can do its main job has one chance
 * to say so and no interface of its own to say it in. Installing used to do
 * nothing at all: no window, no badge, nothing until the user happened to open
 * a Markdown file, open the panel, and read a line in a banner.
 *
 * So the toolbar icon carries the state. A badge is the one piece of persistent
 * UI available on every page, and it costs nothing to look at.
 *
 * Reading public repositories genuinely works without a token, so this is not
 * an error and must be dismissable. Nagging someone who is using the extension
 * exactly as intended teaches them to ignore the badge.
 */
async function reflectSetupState() {
  const stored = await chrome.storage.local.get(['token', 'setupDismissed']);
  const settled = !!stored.token || !!stored.setupDismissed;

  await chrome.action.setBadgeText({ text: settled ? '' : '!' });
  if (!settled) {
    await chrome.action.setBadgeBackgroundColor({ color: '#BF8700' });
  }
  await chrome.action.setTitle({
    title: settled
      ? 'Show or hide comments (Alt+C)'
      : 'Markdown Comments: add a GitHub token to post comments'
  });
}

chrome.runtime.onInstalled.addListener(function (details) {
  reflectSetupState();
  // Only on a fresh install. Reopening this on every update would be a page
  // stealing focus to tell someone what they already did.
  if (details.reason === 'install') {
    chrome.runtime.openOptionsPage().catch(function () { /* nothing else to try */ });
  }
});

if (chrome.runtime.onStartup) chrome.runtime.onStartup.addListener(reflectSetupState);

chrome.storage.onChanged.addListener(function (changes, area) {
  if (area !== 'local') return;
  if (changes.token || changes.setupDismissed) reflectSetupState();
});

// The worker is torn down and restarted freely, and the badge does not survive
// with it, so the state is reasserted whenever this script runs at all.
reflectSetupState();

if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener(function (command) {
    if (command === 'toggle-comments') togglePanelInActiveTab(null);
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  const handler = handlers[message && message.type];
  if (!handler) {
    sendResponse({ error: 'Unknown request: ' + (message && message.type) });
    return false;
  }
  handler(message)
    .then(function (result) { sendResponse({ ok: true, result: result }); })
    .catch(function (error) {
      sendResponse({
        ok: false,
        error: error.message || String(error),
        // What a caller acts on differently; the message covers the rest.
        status: error.status || 0,
        protectedBranch: !!error.protectedBranch
      });
    });
  return true; // response is async
});

'use strict';

const tokenInput = document.getElementById('token');
const statusBox = document.getElementById('status');
const saveButton = document.getElementById('save');
const clearButton = document.getElementById('clear');

function show(message, ok) {
  statusBox.textContent = message;
  statusBox.className = 'status ' + (ok ? 'ok' : 'err');
}

function send(message) {
  return new Promise(function (resolve, reject) {
    chrome.runtime.sendMessage(message, function (response) {
      if (chrome.runtime.lastError) return reject(new Error(chrome.runtime.lastError.message));
      if (!response || !response.ok) return reject(new Error((response && response.error) || 'No response'));
      resolve(response.result);
    });
  });
}

chrome.storage.local.get(['token', 'login']).then(function (stored) {
  if (stored.token) {
    tokenInput.value = stored.token;
    show(stored.login ? 'Signed in as @' + stored.login + '.' : 'A token is saved.', true);
  }
});

saveButton.addEventListener('click', async function () {
  const token = tokenInput.value.trim();
  if (!token) return show('Paste a token first.', false);

  saveButton.disabled = true;
  show('Checking with GitHub...', true);
  try {
    // Validate before storing, so a typo never becomes the saved state.
    const user = await send({ type: 'validateToken', token: token });
    await chrome.storage.local.set({ token: token, login: user.login });
    // Deliberately not "you're all set": this only proves the token is valid,
    // not that it was granted the repository you want to comment in.
    show('Token is valid, signed in as @' + user.login +
         '. Now check the repository below, since access is granted per repository.', true);
  } catch (error) {
    show(error.message, false);
  } finally {
    saveButton.disabled = false;
  }
});

const repoInput = document.getElementById('repo');
const repoStatus = document.getElementById('repoStatus');
const checkButton = document.getElementById('check');

function showRepo(message, ok) {
  repoStatus.textContent = message;
  repoStatus.className = 'status ' + (ok ? 'ok' : 'err');
}

checkButton.addEventListener('click', async function () {
  const value = repoInput.value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\/+$/, '');
  const parts = value.split('/');
  if (parts.length < 2 || !parts[0] || !parts[1]) {
    return showRepo('Enter it as owner/repository, for example pjdoland/scribbles.', false);
  }

  checkButton.disabled = true;
  showRepo('Checking...', true);
  try {
    const repo = await send({ type: 'checkRepo', owner: parts[0], repo: parts[1] });
    if (repo.canPush) {
      showRepo('Access confirmed for ' + repo.fullName +
               (repo.isPrivate ? ' (private)' : ' (public)') +
               '. You can post comments here.', true);
    } else {
      showRepo('The token can read ' + repo.fullName + ' but not write to it. ' +
               'Grant it Contents: read and write.', false);
    }
  } catch (error) {
    showRepo(error.message + ' If the repository exists and you can see it on ' +
             'github.com, the token was probably not granted access to it. ' +
             'Fine-grained tokens list repositories individually.', false);
  } finally {
    checkButton.disabled = false;
  }
});

clearButton.addEventListener('click', async function () {
  await chrome.storage.local.remove(['token', 'login']);
  tokenInput.value = '';
  show('Token removed. Public repositories are still readable.', true);
});

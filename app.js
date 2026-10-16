/* sCure Org Key - puts the organization ID on a USB drive as the CSV the sCure Box reads.
 *
 * The sCure Box (Settings > Organization > Link Organization) lists *.csv files on a USB drive and takes the first
 * UUID it finds in the file. So the file only has to be a .csv holding the ID.
 */
'use strict';

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const RECENT_KEY = 'scure-org-key.recent';
const RECENT_MAX = 5;

/** The first UUID in any text (a pasted message, JSON, a CSV), lower-cased; null if there is none. */
function extractOrgId(text) {
  const m = UUID.exec(String(text || ''));
  return m ? m[0].toLowerCase() : null;
}

/** CSV cell: quoted when it holds a comma, quote or line break. */
function csvCell(value) {
  const v = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim();
  return /[",]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}

/** The file the sCure Box reads. Header first (it holds no UUID), then the ID and the optional name. */
function buildCsv(orgId, name) {
  return 'organization_id,organization_name\r\n' + orgId + ',' + csvCell(name) + '\r\n';
}

/** scure-organization.csv, or scure-organization-<name>.csv with a safe version of the name. */
function fileNameFor(name) {
  const slug = String(name || '').toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return slug ? 'scure-organization-' + slug + '.csv' : 'scure-organization.csv';
}

// ---- Origin sign-in (first stage) ----
//
// Email + password go to Origin's sign-in service (Firebase, with the public web key of app.origin.io). The organization is
// looked for in what comes back: the token's claims, the account record, and - if Origin ever allows this address - the
// GraphQL "me" query. Origin's API does not allow this address yet, so the last step usually cannot run; the screen then
// says so and keeps the ID field for typing. The password and the tokens are never stored.

const ORIGIN = {
  key: 'AIzaSyCCojIe0wscxKRbuVqlaFTmxF-UT7SMJRk',
  auth: 'https://identitytoolkit.googleapis.com/v1/accounts',
  graphql: 'https://api.origin.io/graphql',
  meQuery: 'query Me { me { id email organizationId organization { id name } } }',
};

function decodeJwt(token) {
  try {
    const part = String(token).split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const bin = atob(part + '='.repeat((4 - part.length % 4) % 4));
    return JSON.parse(new TextDecoder().decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
  } catch (e) {
    return null;
  }
}

/** The organization in any object: a key that mentions "org" holding a UUID (JSON strings inside are opened too). */
function findOrganization(value, depth) {
  depth = depth || 0;
  if (value == null || depth > 6) return null;
  if (typeof value === 'string') {
    if (/^\s*[{[]/.test(value)) { try { return findOrganization(JSON.parse(value), depth + 1); } catch (e) { return null; } }
    return null;
  }
  if (typeof value !== 'object') return null;
  for (const [k, v] of Object.entries(value)) {
    if (/org/i.test(k) && typeof v === 'string' && extractOrgId(v) && v.trim().length === 36) {
      const org = value.organization && typeof value.organization === 'object' ? value.organization : null;
      return { id: v.trim().toLowerCase(), name: (org && org.name) || (typeof value.organizationName === 'string' ? value.organizationName : '') || '' };
    }
  }
  for (const v of Object.values(value)) {
    const r = findOrganization(v, depth + 1);
    if (r) return r;
  }
  return null;
}

function signInError(code) {
  const c = String(code || '').split(/[ :]/)[0];
  if (['INVALID_LOGIN_CREDENTIALS', 'INVALID_PASSWORD', 'EMAIL_NOT_FOUND', 'INVALID_EMAIL'].includes(c)) return 'Wrong email or password';
  if (c === 'USER_DISABLED') return 'This Origin account is disabled';
  if (c === 'TOO_MANY_ATTEMPTS_TRY_LATER') return 'Too many attempts - wait a few minutes and try again';
  return 'Sign-in failed' + (c ? ' (' + c + ')' : '') + ' - try again';
}

/** Never show or keep tokens: this is what the "What Origin returned" box prints. */
function redact(value) {
  if (value == null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(redact);
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    out[k] = /token|secret|password/i.test(k) ? '(hidden)' : redact(v);
  }
  return out;
}

async function postJson(fetchFn, url, body, headers) {
  const r = await fetchFn(url, { method: 'POST', headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}), body: JSON.stringify(body) });
  let json = null;
  try { json = await r.json(); } catch (e) { /* not JSON */ }
  return { ok: r.ok, status: r.status, json };
}

/**
 * Sign in and look for the organization. Returns
 * {error} | {email, org: {id, name}|null, where: 'token'|'account'|'api'|null, apiBlocked, returned}.
 */
async function originSignIn(email, password, fetchFn) {
  fetchFn = fetchFn || ((u, o) => fetch(u, o));
  email = String(email || '').trim();
  if (!email || !password) return { error: 'Enter your email and password' };
  let signed;
  try {
    signed = await postJson(fetchFn, ORIGIN.auth + ':signInWithPassword?key=' + ORIGIN.key, { email, password, returnSecureToken: true });
  } catch (e) {
    return { error: 'No connection to Origin - check the network' };
  }
  const idToken = signed.json && signed.json.idToken;
  if (!signed.ok || !idToken) return { error: signInError(signed.json && signed.json.error && signed.json.error.message) };

  const claims = decodeJwt(idToken);
  const returned = { token_claims: redact(claims) };
  let org = findOrganization(claims), where = org ? 'token' : null;

  try {
    const look = await postJson(fetchFn, ORIGIN.auth + ':lookup?key=' + ORIGIN.key, { idToken });
    const user = look.json && look.json.users && look.json.users[0];
    if (user) {
      returned.account = redact(user);
      if (!org) { org = findOrganization(user); where = org ? 'account' : null; }
    }
  } catch (e) { /* the account record is a bonus */ }

  let apiBlocked = false;
  if (!org) {
    try {
      const api = await postJson(fetchFn, ORIGIN.graphql, { operationName: 'Me', query: ORIGIN.meQuery, variables: {} }, { Authorization: 'Bearer ' + idToken });
      returned.api = redact(api.json);
      org = findOrganization(api.json);
      where = org ? 'api' : null;
    } catch (e) {
      apiBlocked = true;   // the browser refused: Origin's API does not allow this address
      returned.api = 'blocked by the browser (Origin does not allow this app address yet)';
    }
  }
  return { email: (claims && claims.email) || email, org, where, apiBlocked, returned };
}

// ---- the bookmark for Google / Microsoft sign-in ----

/** The javascript: address of the bookmark: the function of bookmarklet.js squeezed onto one line, called with this app's address. */
function bookmarkletUrl(fn, appUrl) {
  const body = String(fn)
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\s+/g, ' ')
    .trim();
  return 'javascript:(' + body + ')(' + JSON.stringify(appUrl) + ');void 0;';
}

/** What the bookmark brings back: #org=<id>&name=<name> - {id, name} or null. */
function readOrgFromHash(hash) {
  const m = /[#&]org=([^&]+)/.exec(hash || '');
  if (!m) return null;
  let id = null;
  try { id = extractOrgId(decodeURIComponent(m[1])); } catch (e) { /* bad escape */ }
  if (!id) return null;
  let name = '';
  const n = /[#&]name=([^&]*)/.exec(hash);
  if (n) { try { name = decodeURIComponent(n[1]); } catch (e) { /* ignore */ } }
  return { id, name: name.slice(0, 80) };
}

// ---- recent list (a convenience only: every read and write is guarded) ----

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter(x => x && extractOrgId(x.id)).slice(0, RECENT_MAX) : [];
  } catch (e) {
    return [];
  }
}

function rememberOrg(id, name) {
  try {
    const rest = loadRecent().filter(x => x.id !== id);
    localStorage.setItem(RECENT_KEY, JSON.stringify([{ id, name: name || '' }].concat(rest).slice(0, RECENT_MAX)));
  } catch (e) { /* private window: nothing to remember */ }
}

// ---- saving ----

/**
 * Save the CSV where the person chooses (the USB drive):
 *   1. the file picker (desktop Chrome / Edge, newer Android Chrome) - writes straight to the chosen place;
 *   2. the share sheet with the file (iPhone: "Save to Files" > the drive; Android: the Files app);
 *   3. a plain download (goes to Downloads; the help text says how to move it to the drive).
 * Returns {method, cancelled?}.
 */
async function saveCsv(fileName, text, env) {
  env = env || window;
  const nav = env.navigator || navigator;
  if (typeof env.showSaveFilePicker === 'function') {
    try {
      const handle = await env.showSaveFilePicker({
        suggestedName: fileName,
        types: [{ description: 'CSV file', accept: { 'text/csv': ['.csv'] } }],
      });
      const w = await handle.createWritable();
      await w.write(text);
      await w.close();
      return { method: 'picker' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { method: 'picker', cancelled: true };
      // any other failure (blocked, unsupported target): try the next way
    }
  }
  const file = new File([text], fileName, { type: 'text/csv' });
  if (typeof nav.canShare === 'function' && nav.canShare({ files: [file] }) && typeof nav.share === 'function') {
    try {
      await nav.share({ files: [file], title: fileName });
      return { method: 'share' };
    } catch (e) {
      if (e && e.name === 'AbortError') return { method: 'share', cancelled: true };
    }
  }
  const url = URL.createObjectURL(file);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
  return { method: 'download' };
}

// ---- the page ----

function initPage() {
  const $ = id => document.getElementById(id);
  const idInput = $('orgId'), nameInput = $('orgName'), saveBtn = $('saveBtn');
  const idStatus = $('idStatus'), saveStatus = $('saveStatus'), fileLabel = $('fileName');
  let currentId = null;

  function setStatus(el, text, kind) {
    el.textContent = text || '';
    el.className = 'status' + (kind ? ' ' + kind : '');
  }

  function refresh() {
    const raw = idInput.value.trim();
    currentId = extractOrgId(raw);
    idInput.classList.toggle('valid', !!currentId);
    idInput.classList.toggle('invalid', !currentId && raw.length > 0);
    if (currentId) setStatus(idStatus, 'Valid organization ID', 'ok');
    else if (raw.length) setStatus(idStatus, 'This is not an organization ID yet (8-4-4-4-12 letters and digits)', 'bad');
    else setStatus(idStatus, '');
    fileLabel.textContent = fileNameFor(nameInput.value);
    saveBtn.disabled = !currentId;
    setStatus(saveStatus, '');
  }

  // a pasted message becomes just the ID
  idInput.addEventListener('paste', e => {
    const text = (e.clipboardData && e.clipboardData.getData('text')) || '';
    const id = extractOrgId(text);
    if (id) {
      e.preventDefault();
      idInput.value = id;
      refresh();
    }
  });
  idInput.addEventListener('input', refresh);
  nameInput.addEventListener('input', refresh);

  $('pasteBtn').addEventListener('click', async () => {
    try {
      const text = await navigator.clipboard.readText();
      idInput.value = extractOrgId(text) || text.trim();
    } catch (e) {
      setStatus(idStatus, 'Paste is not allowed here - long-press the field and choose Paste', 'bad');
      idInput.focus();
      return;
    }
    refresh();
  });

  $('openFile').addEventListener('change', async e => {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const id = extractOrgId(await f.text());
    idInput.value = id || '';
    refresh();
    if (!id) setStatus(idStatus, 'No organization ID found in ' + f.name, 'bad');
    e.target.value = '';
  });

  saveBtn.addEventListener('click', async () => {
    if (!currentId) return;
    const name = nameInput.value.trim();
    const fileName = fileNameFor(name);
    saveBtn.disabled = true;
    try {
      const r = await saveCsv(fileName, buildCsv(currentId, name));
      if (r.cancelled) {
        setStatus(saveStatus, 'Cancelled - nothing was saved', 'bad');
      } else {
        rememberOrg(currentId, name);
        renderRecent();
        if (r.method === 'download') {
          setStatus(saveStatus, 'Saved ' + fileName + ' to Downloads. Move it to the USB drive (see below).', 'ok');
          $('saveHelp').open = true;
        } else {
          setStatus(saveStatus, 'Saved ' + fileName + '. Now plug the drive into the sCure Box.', 'ok');
        }
      }
    } catch (e) {
      setStatus(saveStatus, 'Could not save the file: ' + (e && e.message ? e.message : e), 'bad');
    } finally {
      saveBtn.disabled = !currentId;
    }
  });

  function renderRecent() {
    const list = loadRecent();
    const ul = $('recent');
    ul.textContent = '';
    $('recentCard').hidden = list.length === 0;
    list.forEach(item => {
      const li = document.createElement('li');
      const b = document.createElement('button');
      b.type = 'button';
      const nm = document.createElement('span');
      nm.className = 'nm';
      nm.textContent = item.name || 'Organization';
      const id = document.createElement('span');
      id.className = 'id';
      id.textContent = item.id;
      b.append(nm, id);
      b.addEventListener('click', () => {
        idInput.value = item.id;
        nameInput.value = item.name || '';
        refresh();
        window.scrollTo({ top: 0, behavior: 'smooth' });
      });
      li.appendChild(b);
      ul.appendChild(li);
    });
  }

  // ---- Google / Microsoft bookmark ----
  const appUrl = location.origin + location.pathname;
  const bmCode = typeof scureOriginBookmarklet === 'function' ? bookmarkletUrl(scureOriginBookmarklet, appUrl) : '';
  $('bmCode').textContent = bmCode;
  $('bmCopy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(bmCode);
      setStatus($('bmStatus'), 'Copied. Paste it as the address of a new bookmark.', 'ok');
    } catch (e) {
      // no clipboard access: select the code so it can be copied by hand
      const range = document.createRange();
      range.selectNodeContents($('bmCode'));
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      $('bmCode').closest('details').open = true;
      setStatus($('bmStatus'), 'Could not copy automatically - the code is selected below: long-press it and choose Copy.', 'bad');
    }
  });

  // back from the bookmark with the organization in the address (also when this page was already open)
  function applyHash() {
    const fromOrigin = readOrgFromHash(location.hash);
    if (location.hash) history.replaceState(null, '', location.pathname + location.search);
    if (!fromOrigin) return;
    idInput.value = fromOrigin.id;
    if (fromOrigin.name) nameInput.value = fromOrigin.name;
    refresh();
    setStatus(idStatus, 'Received from Origin' + (fromOrigin.name ? ': ' + fromOrigin.name : '') + '. Now save it to the USB drive.', 'ok');
  }
  window.addEventListener('hashchange', applyHash);

  // ---- Origin sign-in card ----
  const oEmail = $('oEmail'), oPass = $('oPass'), oSignIn = $('oSignIn'), oStatus = $('oStatus');
  function oRefresh() { oSignIn.disabled = !(oEmail.value.trim() && oPass.value); }
  oEmail.addEventListener('input', oRefresh);
  oPass.addEventListener('input', oRefresh);
  $('oShow').addEventListener('click', () => {
    const show = oPass.type === 'password';
    oPass.type = show ? 'text' : 'password';
    $('oShow').textContent = show ? 'Hide' : 'Show';
    $('oShow').setAttribute('aria-pressed', String(show));
  });
  function oSignedOut() {
    $('signedOut').hidden = false;
    $('signedIn').hidden = true;
    oPass.value = '';
    oRefresh();
  }
  $('oSignOut').addEventListener('click', () => {
    oSignedOut();
    $('oDetails').hidden = true;
    setStatus(oStatus, '');
  });
  oSignIn.addEventListener('click', async () => {
    oSignIn.disabled = true;
    oSignIn.textContent = 'Signing in...';
    setStatus(oStatus, '');
    let r;
    try {
      r = await originSignIn(oEmail.value, oPass.value, window.__fetch);
    } finally {
      oSignIn.textContent = 'Sign in';
    }
    oPass.value = '';   // the password is not kept
    if (r.error) {
      oRefresh();
      setStatus(oStatus, r.error, 'bad');
      return;
    }
    $('signedOut').hidden = true;
    $('signedIn').hidden = false;
    $('oWho').textContent = r.email;
    $('oRaw').textContent = JSON.stringify(r.returned, null, 2);
    $('oDetails').hidden = false;
    if (r.org) {
      idInput.value = r.org.id;
      if (r.org.name) nameInput.value = r.org.name;
      refresh();
      setStatus(oStatus, 'Organization found' + (r.org.name ? ': ' + r.org.name : '') + '. Now save it to the USB drive.', 'ok');
    } else {
      setStatus(oStatus, r.apiBlocked
        ? 'Signed in, but Origin does not send the organization to this app yet. Type or paste the ID below.'
        : 'Signed in, but no organization came back. Type or paste the ID below.', 'bad');
    }
  });
  oRefresh();

  // install
  let deferred = null;
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferred = e;
    $('installBtn').hidden = false;
  });
  $('installBtn').addEventListener('click', async () => {
    if (!deferred) return;
    deferred.prompt();
    await deferred.userChoice;
    deferred = null;
    $('installBtn').hidden = true;
  });
  window.addEventListener('appinstalled', () => { $('installBtn').hidden = true; });
  const ios = /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  $('iosHint').hidden = !(ios && !standalone);

  refresh();
  renderRecent();
  applyHash();
}

if (typeof document !== 'undefined' && document.getElementById('orgId')) {
  initPage();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

if (typeof module !== 'undefined') module.exports = { bookmarkletUrl, readOrgFromHash, extractOrgId, buildCsv, fileNameFor, csvCell, saveCsv, originSignIn, findOrganization, decodeJwt };

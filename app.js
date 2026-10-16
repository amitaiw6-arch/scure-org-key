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
}

if (typeof document !== 'undefined' && document.getElementById('orgId')) {
  initPage();
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
  }
}

if (typeof module !== 'undefined') module.exports = { extractOrgId, buildCsv, fileNameFor, csvCell, saveCsv };

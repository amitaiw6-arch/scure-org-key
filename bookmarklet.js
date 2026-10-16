/* The bookmark that gets the organization ID from app.origin.io (Google, Microsoft or email sign-in).
 *
 * It runs inside the Origin page, in the signed-in person's own browser, and:
 *   1. looks for the organization in the page's own storage; if it is not there
 *   2. asks Origin's own API (api.origin.io - the only place the sign-in token is ever sent) for "me"'s organization;
 *   3. goes back to this app with only the ID (and name) in the address: <app>#org=<id>&name=<name>.
 * Nothing is stored or sent anywhere else. app.js turns this function's text into the bookmark's address.
 *
 * Keep it plain: no line comments, no multiple spaces inside strings, no literal hash sign (the text is squeezed into a
 * javascript: address, where a hash would cut it off).
 */
function scureOriginBookmarklet(pwa) {
  var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  var say = function (m) { alert('sCure Org Key: ' + m); };
  var done = function (id, name) {
    location.href = pwa + '\x23org=' + String(id).toLowerCase() + (name ? '&name=' + encodeURIComponent(name) : '');
  };
  var find = function (v, d) {
    var k, r;
    if (!v || d > 6 || typeof v !== 'object') return null;
    for (k in v) {
      if (/org/i.test(k) && typeof v[k] === 'string' && UUID.test(v[k])) {
        return { id: v[k], name: (v.organization && v.organization.name) || '' };
      }
    }
    for (k in v) {
      r = find(v[k], d + 1);
      if (r) return r;
    }
    return null;
  };

  if (!/(^|\.)origin\.io$/.test(location.hostname)) {
    return say('open app.origin.io, sign in, then tap this bookmark there');
  }

  /* 1 - the page may keep the organization in its own storage */
  var found = null;
  [localStorage, sessionStorage].forEach(function (s) {
    try {
      for (var i = 0; i < s.length && !found; i++) {
        var key = s.key(i), val = s.getItem(key);
        if (/org/i.test(key) && UUID.test(val)) found = { id: val, name: '' };
        else if (val && val.charAt(0) === '{') {
          try { found = find(JSON.parse(val), 0); } catch (e) { /* not JSON */ }
        }
      }
    } catch (e) { /* storage not readable */ }
  });
  if (found) return done(found.id, found.name);

  /* 2 - ask Origin's API with the session this page is signed in with */
  var open = indexedDB.open('firebaseLocalStorageDb');
  open.onerror = function () { say('could not read the sign-in of this page'); };
  open.onsuccess = function () {
    var req;
    try {
      req = open.result.transaction('firebaseLocalStorage', 'readonly').objectStore('firebaseLocalStorage').getAll();
    } catch (e) {
      return say('you are not signed in on this page - sign in first');
    }
    req.onerror = function () { say('could not read the sign-in of this page'); };
    req.onsuccess = function () {
      var rec = (req.result || []).filter(function (r) { return /^firebase:authUser:/.test(r.fbase_key); })[0];
      var t = rec && rec.value && rec.value.stsTokenManager;
      if (!t || !t.accessToken) return say('you are not signed in on this page - sign in first');
      if (t.expirationTime && t.expirationTime < Date.now()) {
        return say('your sign-in has expired - reload this page, then tap the bookmark again');
      }
      var ask = function (query) {
        return fetch('https://api.origin.io/graphql', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + t.accessToken },
          body: JSON.stringify({ operationName: 'Me', query: query, variables: {} })
        }).then(function (r) { return r.json(); });
      };
      ask('query Me { me { id organizationId organization { id name } } }').then(function (j) {
        var r = find(j && j.data, 0);
        if (r) return r;
        return ask('query Me { me { organizationId } }').then(function (j2) { return find(j2 && j2.data, 0); });
      }).then(function (r) {
        if (r) done(r.id, r.name);
        else say('Origin did not return an organization for this account');
      }).catch(function () { say('could not reach Origin - check the connection'); });
    };
  };
}

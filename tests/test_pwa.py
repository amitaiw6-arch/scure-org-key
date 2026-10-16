"""Browser tests of the sCure Org Key PWA (run: python pwa/tests/test_pwa.py [--shots DIR]).

Serves pwa/ on localhost (a secure context, like the HTTPS host), drives it in Chrome with a phone-sized screen and checks:
the page, the installable manifest, offline use, ID extraction and validation, the CSV the sCure Box reads, and the three
ways of saving (file picker, share sheet, download) including cancel.
"""
import http.server
import json
import os
import re
import sys
import threading
from functools import partial
from pathlib import Path

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parent.parent
ORG = "3f2504e0-4f89-11d3-9a0c-0305e82c3301"
# the machine's pattern (SetupViewModel.OrganizationIdPattern)
MACHINE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)

SHOTS = None
if "--shots" in sys.argv:
    SHOTS = Path(sys.argv[sys.argv.index("--shots") + 1])
    SHOTS.mkdir(parents=True, exist_ok=True)

checks = 0


def check(cond, msg):
    global checks
    checks += 1
    if not cond:
        raise AssertionError(msg)
    print("  ok:", msg)


class Quiet(http.server.SimpleHTTPRequestHandler):
    def log_message(self, *a):
        pass


def serve():
    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), partial(Quiet, directory=str(ROOT)))
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"http://127.0.0.1:{srv.server_port}/"


PICKER = """
window.__saved = null; window.__pickerOpts = null;
window.showSaveFilePicker = async (opts) => {
  window.__pickerOpts = opts;
  if (window.__cancelPicker) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
  return { createWritable: async () => { let buf = ''; return {
    write: async (t) => { buf += t; }, close: async () => { window.__saved = { name: opts.suggestedName, text: buf }; } }; } };
};
"""

SHARE = """
delete window.showSaveFilePicker;
window.__shared = null;
navigator.canShare = (d) => !!(d && d.files && d.files.length);
navigator.share = async (d) => {
  if (window.__cancelShare) { const e = new Error('cancelled'); e.name = 'AbortError'; throw e; }
  window.__shared = { name: d.files[0].name, type: d.files[0].type, text: await d.files[0].text() };
};
"""

NOTHING = "delete window.showSaveFilePicker; navigator.canShare = undefined; navigator.share = undefined;"


import base64


def jwt(claims):
    enc = lambda o: base64.urlsafe_b64encode(json.dumps(o).encode()).decode().rstrip("=")
    return enc({"alg": "RS256", "typ": "JWT"}) + "." + enc(claims) + ".sig"


# a stand-in for fetch(): window.__route(url, opts) answers; every call is recorded in window.__calls
MOCK = """
window.__calls = [];
window.__json = (o, status) => new Response(JSON.stringify(o), { status: status || 200, headers: { 'Content-Type': 'application/json' } });
window.__fetch = async (url, opts) => {
  window.__calls.push({ url, body: opts && opts.body, auth: opts && opts.headers && opts.headers.Authorization });
  return window.__route(url, opts);
};
window.__route = () => { throw new TypeError('Failed to fetch'); };
"""


def route(page, js_body):
    """Set how the stand-in Origin answers: js_body is the body of function (url, opts)."""
    page.evaluate("(() => { window.__route = (url, opts) => { %s }; return 0; })()" % js_body)


def sign_in(page, email="nurse@clinic.com", password="s3cret!"):
    page.fill("#oEmail", email)
    page.fill("#oPass", password)
    page.click("#oSignIn")
    page.wait_for_function("document.getElementById('oStatus').textContent !== '' || document.getElementById('signedIn').hidden === false")
    page.wait_for_function("document.getElementById('oSignIn').textContent === 'Sign in'")


def new_page(browser, base, script=None):
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, device_scale_factor=2, is_mobile=True, has_touch=True,
                              accept_downloads=True)
    if script:
        ctx.add_init_script(script)
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    page.wait_for_selector("#orgId")
    return ctx, page, errors


def shot(page, name):
    if SHOTS:
        page.screenshot(path=str(SHOTS / name), full_page=True)


def run_bookmark(browser, base):
    print("Google / Microsoft bookmark")
    ctx = browser.new_context(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True,
                              permissions=["clipboard-read", "clipboard-write"])
    ctx.add_init_script("Object.defineProperty(navigator, 'share', { value: undefined, configurable: true });")   # desktop: copy instead
    page = ctx.new_page()
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.goto(base)
    code = page.text_content("#bmCode")
    check(code.startswith("javascript:(function scureOriginBookmarklet(pwa)"), "bookmark address is the javascript: function")
    check("\n" not in code and "#" not in code and "/*" not in code, "one line, no hash sign, no comments")
    check(code.endswith("(" + json.dumps(base) + ");void 0;"), "called with this app's address")
    page.click("#bmCopy")
    page.wait_for_function("document.getElementById('bmStatus').textContent.startsWith('Copied')")
    check(page.evaluate("navigator.clipboard.readText()") == code, "Copy puts the code on the clipboard")
    shot(page, "06-google-card.png")

    check(page.get_attribute("#bmDrag", "href") == code, "the draggable link holds the same code")
    page.click("#bmDrag")
    check("Drag" in page.inner_text("#bmStatus") and page.url.startswith(base), "tapping the draggable link does not run it here")

    # share a link to another phone
    check(page.locator("#shareRow").is_hidden(), "no share button without an ID")
    page.fill("#orgId", ORG)
    page.fill("#orgName", "Acme Dental")
    check(page.locator("#shareRow").is_visible(), "share button with a valid ID")
    page.click("#shareBtn")
    page.wait_for_function("document.getElementById('shareStatus').textContent.startsWith('Link copied')")
    link = page.evaluate("navigator.clipboard.readText()")
    check(link == base + "#org=" + ORG + "&name=Acme%20Dental", "the copied link: " + link)
    page.goto("about:blank")

    # back from the bookmark
    page.goto(base + "#org=" + ORG.upper() + "&name=Acme%20Dental")
    page.wait_for_selector("#orgId")
    check(page.input_value("#orgId") == ORG and page.input_value("#orgName") == "Acme Dental", "the app fills ID and name from the address")
    check("Received from Origin: Acme Dental" in page.inner_text("#idStatus"), "says where it came from")
    check(page.evaluate("location.hash") == "" and page.locator("#saveBtn").is_enabled(), "address cleaned, Save ready")
    page.goto(base + "?fresh=1#org=not-an-id")   # a new page load, not just a changed address
    page.wait_for_selector("#orgId")
    check(page.input_value("#orgId") == "" and page.evaluate("location.hash") == "", "a bad address is ignored")
    page.goto(base + "#org=" + ORG)               # the page is open already: a changed address is picked up too
    page.wait_for_function("document.getElementById('orgId').value !== ''")
    check(page.input_value("#orgId") == ORG, "an open page picks up a changed address")

    # the bookmark on a stand-in Origin
    seen = {"api": [], "auth_hosts": set(), "dialogs": []}
    page.on("dialog", lambda d: (seen["dialogs"].append(d.message), d.accept()))

    def api(route):
        req = route.request
        cors = {"access-control-allow-origin": "https://app.origin.io", "access-control-allow-headers": "authorization, content-type",
                "access-control-allow-methods": "POST, OPTIONS"}
        if req.method == "OPTIONS":
            return route.fulfill(status=204, headers=cors)
        body = json.loads(req.post_data or "{}")
        seen["api"].append({"auth": req.headers.get("authorization"), "query": body.get("query", "")})
        mode = state["api"]
        if mode == "none":
            data = {"data": {"me": {"id": "u1", "organizationId": None}}}
        elif mode == "second" and "organization { id name }" in body.get("query", ""):
            data = {"errors": [{"message": "Cannot query field"}], "data": None}
        else:
            data = {"data": {"me": {"id": "u1", "organizationId": ORG, "organization": {"id": ORG, "name": "Acme Dental"}}}}
        route.fulfill(status=200, headers=dict(cors, **{"content-type": "application/json"}), body=json.dumps(data))

    state = {"api": "ok"}
    ctx.route("https://api.origin.io/graphql", api)
    ctx.route("https://app.origin.io/**", lambda r: r.fulfill(status=200, content_type="text/html", body="<!doctype html><title>Origin</title><body>app</body>"))

    def on_request(req):
        if req.headers.get("authorization"):
            seen["auth_hosts"].add(req.url.split("/")[2])
    ctx.on("request", on_request)

    def seed(expires_in_ms=3600000, token="tok-123", signed_in=True, local=None):
        page.goto("https://app.origin.io/models")
        page.evaluate("""async ([exp, token, signedIn, local]) => {
          localStorage.clear(); sessionStorage.clear();
          if (local) localStorage.setItem(local[0], local[1]);
          await new Promise((res, rej) => { const del = indexedDB.deleteDatabase('firebaseLocalStorageDb'); del.onsuccess = res; del.onerror = rej; del.onblocked = res; });
          await new Promise((res, rej) => {
            const open = indexedDB.open('firebaseLocalStorageDb', 1);
            open.onupgradeneeded = () => open.result.createObjectStore('firebaseLocalStorage', { keyPath: 'fbase_key' });
            open.onsuccess = () => {
              if (!signedIn) return res();
              const tx = open.result.transaction('firebaseLocalStorage', 'readwrite');
              tx.objectStore('firebaseLocalStorage').put({ fbase_key: 'firebase:authUser:KEY:[DEFAULT]',
                value: { uid: 'u', email: 'a@b.com', stsTokenManager: { accessToken: token, refreshToken: 'REFRESH', expirationTime: Date.now() + exp } } });
              tx.oncomplete = res; tx.onerror = rej;
            };
            open.onerror = rej;
          });
        }""", [expires_in_ms, token, signed_in, local])
        seen["api"].clear()

    def tap_bookmark(wait_for_pwa=True):
        seen["dialogs"].clear()
        page.evaluate(code[len("javascript:"):])
        if wait_for_pwa:
            page.wait_for_url(base + "**")
            page.wait_for_selector("#orgId")
        else:
            page.wait_for_function("true")
            for _ in range(40):
                if seen["dialogs"]:
                    break
                page.wait_for_timeout(100)

    seed()
    tap_bookmark()
    check(page.input_value("#orgId") == ORG and page.input_value("#orgName") == "Acme Dental", "signed-in session: back in the app with ID and name")
    check(seen["api"][0]["auth"] == "Bearer tok-123", "the API was asked with the page's own token")
    check(seen["auth_hosts"] == {"api.origin.io"}, "the token went to api.origin.io only: %s" % seen["auth_hosts"])
    check(page.evaluate("location.hash") == "", "address cleaned")

    state["api"] = "second"
    seed()
    tap_bookmark()
    check(page.input_value("#orgId") == ORG and len(seen["api"]) == 2, "a second, simpler question when the first is refused")

    state["api"] = "ok"
    seed(local=("currentOrganizationId", ORG))
    tap_bookmark()
    check(page.input_value("#orgId") == ORG and seen["api"] == [], "the page's own storage is used first - no API call")

    seed(expires_in_ms=-60000)
    tap_bookmark(wait_for_pwa=False)
    check(len(seen["dialogs"]) == 1 and "expired" in seen["dialogs"][0] and seen["api"] == [], "an expired sign-in asks to reload; nothing sent: dialogs=%r api=%r url=%s" % (seen["dialogs"], seen["api"], page.url))

    seed(signed_in=False)
    tap_bookmark(wait_for_pwa=False)
    check("not signed in" in seen["dialogs"][0], "not signed in is explained")

    state["api"] = "none"
    seed()
    tap_bookmark(wait_for_pwa=False)
    check("did not return an organization" in seen["dialogs"][0], "an account without an organization is explained")

    page.goto(base)
    tap_bookmark(wait_for_pwa=False)
    check("open app.origin.io" in seen["dialogs"][0], "on any other site it says where to use it")
    check(not errors, "no script errors: %s" % errors)
    ctx.close()


def run(base):
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)

        print("page, manifest, icons")
        ctx, page, errors = new_page(browser, base)
        check(page.title() == "sCure Org Key", "title")
        check(page.locator("#saveBtn").is_disabled(), "Save is off until there is an ID")
        shot(page, "01-empty.png")
        man = json.loads(page.evaluate("fetch('manifest.webmanifest').then(r => r.text())"))
        check(man["display"] == "standalone" and man["start_url"] == "./", "manifest: standalone, start_url")
        check({i["purpose"] for i in man["icons"]} >= {"any", "maskable"}, "manifest: any + maskable icons")
        for icon in man["icons"]:
            check(page.evaluate("src => fetch(src).then(r => r.ok)", icon["src"]), "icon served: " + icon["src"])
        check(page.evaluate("fetch('icons/apple-touch-icon.png').then(r => r.ok)"), "apple-touch-icon served")

        print("validation and extraction")
        page.fill("#orgId", "not an id")
        check("not an organization ID" in page.inner_text("#idStatus"), "bad text is refused")
        check(page.locator("#saveBtn").is_disabled(), "Save stays off")
        page.fill("#orgId", ORG.upper())
        check("Valid" in page.inner_text("#idStatus") and page.locator("#saveBtn").is_enabled(), "an upper-case ID is valid")
        page.fill("#orgId", "")
        page.evaluate("""(t) => { const i = document.getElementById('orgId'); i.focus();
            const dt = new DataTransfer(); dt.setData('text', t);
            i.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true })); }""",
                      "Hi, your org is {\"organizationId\": \"%s\"} - thanks!" % ORG.upper())
        check(page.input_value("#orgId") == ORG, "a pasted message becomes the lower-case ID")
        page.set_input_files("#openFile", files=[{"name": "organizationId.txt", "mimeType": "text/plain",
                                                  "buffer": ('{"me":{"organizationId":"%s"}}' % ORG).encode()}])
        page.wait_for_function("document.getElementById('orgId').value !== ''")
        check(page.input_value("#orgId") == ORG, "the ID is read from a file")
        page.set_input_files("#openFile", files=[{"name": "x.txt", "mimeType": "text/plain", "buffer": b"nothing here"}])
        page.wait_for_function("document.getElementById('idStatus').textContent.includes('No organization ID')")
        check(page.input_value("#orgId") == "", "a file without an ID clears the field")
        check(not errors, "no script errors: %s" % errors)
        ctx.close()

        print("save with the file picker")
        ctx, page, errors = new_page(browser, base, PICKER)
        page.fill("#orgId", ORG)
        page.fill("#orgName", 'Acme, "Dental" Lab')
        check(page.inner_text("#fileName") == "scure-organization-acme-dental-lab.csv", "file name from the organization name")
        page.click("#saveBtn")
        page.wait_for_function("window.__saved !== null")
        saved = page.evaluate("window.__saved")
        check(saved["name"] == "scure-organization-acme-dental-lab.csv", "picker got the suggested name")
        lines = saved["text"].split("\r\n")
        check(lines[0] == "organization_id,organization_name", "CSV header")
        check(lines[1] == ORG + ',"Acme, ""Dental"" Lab"', "CSV row, name quoted: " + lines[1])
        check(MACHINE.search(saved["text"]).group(0) == ORG, "the sCure Box finds the ID in the file")
        check(not MACHINE.search(lines[0]), "the header holds no ID the box could mistake")
        check(".csv" in json.dumps(page.evaluate("window.__pickerOpts.types")), "picker is limited to CSV")
        check("Saved" in page.inner_text("#saveStatus"), "saved message")
        check(page.locator("#recentCard").is_visible(), "recent list appears")
        shot(page, "02-saved.png")
        page.reload()
        page.wait_for_selector("#recent button")
        page.click("#recent button")
        check(page.input_value("#orgId") == ORG and page.input_value("#orgName") == 'Acme, "Dental" Lab', "recent restores ID and name")
        page.evaluate("window.__cancelPicker = true")
        page.click("#saveBtn")
        page.wait_for_function("document.getElementById('saveStatus').textContent.includes('Cancelled')")
        check(True, "cancelling the picker says nothing was saved")
        check(not errors, "no script errors: %s" % errors)
        ctx.close()

        print("save with the share sheet (iPhone)")
        ctx, page, errors = new_page(browser, base, SHARE)
        page.fill("#orgId", ORG)
        page.click("#saveBtn")
        page.wait_for_function("window.__shared !== null")
        shared = page.evaluate("window.__shared")
        check(shared["name"] == "scure-organization.csv" and shared["type"] == "text/csv", "shared file name and type")
        check(MACHINE.search(shared["text"]).group(0) == ORG, "shared file holds the ID")
        page.evaluate("window.__cancelShare = true; window.__shared = null")
        page.click("#saveBtn")
        page.wait_for_function("document.getElementById('saveStatus').textContent.includes('Cancelled')")
        check(page.evaluate("window.__shared") is None, "cancelling the share sheet saves nothing")
        ctx.close()

        print("save by download (no picker, no share)")
        ctx, page, errors = new_page(browser, base, NOTHING)
        page.fill("#orgId", ORG)
        with page.expect_download() as dl:
            page.click("#saveBtn")
        d = dl.value
        check(d.suggested_filename == "scure-organization.csv", "downloaded file name")
        check(MACHINE.search(Path(d.path()).read_text()).group(0) == ORG, "downloaded file holds the ID")
        check("Downloads" in page.inner_text("#saveStatus"), "tells where it went")
        check(page.locator("#saveHelp").evaluate("e => e.open"), "the move-to-drive help opens")
        shot(page, "03-download.png")
        ctx.close()

        print("sign in to Origin")
        ctx, page, errors = new_page(browser, base, MOCK)
        check(page.locator("#oSignIn").is_disabled(), "Sign in is off until email and password are typed")
        page.fill("#oEmail", "nurse@clinic.com")
        page.fill("#oPass", "s3cret!")
        check(page.locator("#oSignIn").is_enabled(), "Sign in turns on")
        page.click("#oShow")
        check(page.get_attribute("#oPass", "type") == "text" and page.inner_text("#oShow") == "Hide", "Show reveals the password")
        page.click("#oShow")
        check(page.get_attribute("#oPass", "type") == "password", "Hide covers it again")

        # wrong password
        route(page, "return window.__json({ error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } }, 400);")
        page.click("#oSignIn")
        page.wait_for_function("document.getElementById('oStatus').textContent !== ''")
        check(page.inner_text("#oStatus") == "Wrong email or password", "wrong password message")
        check(page.input_value("#oPass") == "" and page.locator("#signedOut").is_visible(), "password cleared, still signed out")
        call = page.evaluate("window.__calls[0]")
        check("identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=" in call["url"], "calls Origin's sign-in service")
        check(json.loads(call["body"]) == {"email": "nurse@clinic.com", "password": "s3cret!", "returnSecureToken": True}, "sends email and password")

        # the organization is in the token
        page.evaluate("window.__calls = []")
        token = jwt({"email": "nurse@clinic.com", "organizationId": ORG.upper(), "organization": {"name": "Acme Dental"}})
        route(page, "return window.__json({ idToken: '%s', email: 'nurse@clinic.com' });" % token)
        sign_in(page)
        check(page.input_value("#orgId") == ORG, "ID taken from the token claims")
        check(page.input_value("#orgName") == "Acme Dental", "the organization name is taken too")
        check("Organization found" in page.inner_text("#oStatus"), "found message")
        check(page.locator("#signedIn").is_visible() and page.inner_text("#oWho") == "nurse@clinic.com", "signed-in view shows the email")
        check(page.input_value("#oPass") == "", "password not kept")
        check(page.locator("#saveBtn").is_enabled(), "Save is ready")
        raw = page.text_content("#oRaw")
        check("nurse@clinic.com" in raw and "token_claims" in raw, "the box lists what Origin returned")
        check(token not in raw, "the token itself is not printed")
        shot(page, "04-signed-in.png")
        page.click("#oSignOut")
        check(page.locator("#signedOut").is_visible() and page.locator("#oDetails").is_hidden(), "Sign out returns to the form")

        # the organization is in the account record (customAttributes is a JSON string)
        page.fill("#orgId", "")
        page.fill("#orgName", "")
        route(page, """
          if (url.includes('signInWithPassword')) return window.__json({ idToken: '%s' });
          if (url.includes('accounts:lookup')) return window.__json({ users: [{ email: 'nurse@clinic.com', customAttributes: '{"orgId":"%s"}' }] });
          throw new TypeError('Failed to fetch');""" % (jwt({"email": "nurse@clinic.com"}), ORG))
        sign_in(page)
        check(page.input_value("#orgId") == ORG, "ID taken from the account record")
        page.click("#oSignOut")

        # the organization comes from Origin's API (when it allows this address)
        page.fill("#orgId", "")
        route(page, """
          if (url.includes('signInWithPassword')) return window.__json({ idToken: 'a.b.c' });
          if (url.includes('accounts:lookup')) return window.__json({ users: [{ email: 'nurse@clinic.com' }] });
          return window.__json({ data: { me: { organizationId: '%s', organization: { name: 'Acme Dental' } } } });""" % ORG)
        page.evaluate("window.__calls = []")
        sign_in(page)
        check(page.input_value("#orgId") == ORG and page.input_value("#orgName") == "Acme Dental", "ID and name from the API")
        api = [c for c in page.evaluate("window.__calls") if "api.origin.io" in c["url"]][0]
        check(api["auth"] == "Bearer a.b.c" and "organizationId" in api["body"], "API asked with the sign-in token")
        page.click("#oSignOut")

        # Origin's API blocks this address: say so, keep typing possible
        page.fill("#orgId", "")
        page.fill("#orgName", "")
        route(page, """
          if (url.includes('signInWithPassword')) return window.__json({ idToken: '%s' });
          if (url.includes('accounts:lookup')) return window.__json({ users: [{ email: 'nurse@clinic.com' }] });
          throw new TypeError('Failed to fetch');""" % jwt({"email": "nurse@clinic.com", "firebase": {"sign_in_provider": "password"}}))
        sign_in(page)
        check("does not send the organization to this app yet" in page.inner_text("#oStatus"), "blocked API is explained")
        check(page.input_value("#orgId") == "" and page.locator("#saveBtn").is_disabled(), "nothing invented: ID stays empty")
        check("blocked by the browser" in page.text_content("#oRaw"), "details say the API was refused")
        page.fill("#orgId", ORG)
        check(page.locator("#saveBtn").is_enabled(), "typing the ID still works")
        shot(page, "05-api-blocked.png")
        check(not errors, "no script errors: %s" % errors)
        ctx.close()

        run_bookmark(browser, base)

        print("offline")
        ctx, page, errors = new_page(browser, base)
        page.evaluate("navigator.serviceWorker.ready.then(() => true)")
        page.wait_for_function("navigator.serviceWorker.controller !== null || true")
        page.reload()   # the worker now controls the page and has the shell
        page.wait_for_function("navigator.serviceWorker.controller !== null")
        ctx.set_offline(True)
        page.reload()
        page.wait_for_selector("#orgId")
        check(page.title() == "sCure Org Key", "opens with no network")
        ctx.close()

        browser.close()


if __name__ == "__main__":
    srv, base = serve()
    try:
        run(base)
    finally:
        srv.shutdown()
    print(f"\nALL PASSED ({checks} checks)")

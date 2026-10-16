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

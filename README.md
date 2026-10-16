# sCure Org Key (PWA)

A phone app that writes the Origin organization ID to a USB drive as the CSV the sCure Box reads
(Settings > Organization > Link Organization, which lists `*.csv` and takes the first UUID in the file).

Plain static files - no build step, no server code, no data leaves the phone.

| File | What |
|---|---|
| `index.html`, `styles.css`, `app.js` | the app (ID check, CSV, saving) |
| `manifest.webmanifest`, `icons/` | installable on the home screen (Android, iPhone) |
| `sw.js` | offline shell (bump `CACHE` when any file changes) |
| `tests/test_pwa.py` | browser tests (Playwright + Chrome) |

## Saving to the USB drive

1. Desktop Chrome / Edge and newer Android Chrome: the file picker writes straight to the chosen drive.
2. iPhone (USB-C): the share sheet - Save to Files, then the drive.
3. Anything else: a download to Downloads; the app shows how to move it to the drive.

## Run and test

```
python -m http.server 8080      # http://localhost:8080 is a secure context
python tests/test_pwa.py [--shots DIR]
```

## Host

A PWA needs HTTPS to install and to save files. Any static host works (GitHub Pages, Netlify, an S3 bucket): publish
the contents of this folder as the site root (GitHub Pages: Settings > Pages > Deploy from a branch > main / root). Everything uses relative paths, so a sub-path such as
`https://<user>.github.io/<repo>/` works too.

## Not done: reading the ID from Origin

A phone browser cannot read another site's replies, and Origin's API needs Origin's approval for another app. So the
ID is typed or pasted (pasting a whole message is fine). If Origin provides an API or allows this app's address, the
sign-in can be added on the first step.

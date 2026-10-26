# Free10Running website

A self-hosted static copy of the Framer site (https://free10running.framer.media).
The site doesn't load anything from Framer: every page, script, font and image is in `site/`.
It is hosted on GitHub Pages under our own domain.

```
site/                    the website, exactly what gets published
  index.html, event.html, gallery.html, about.html, qa.html, 404.html
  assets/                every script, font and image, downloaded from Framer's CDN
  CNAME                  the custom domain
mirror.mjs               rebuilds site/ from the live Framer site
404.html                 our "page not found" page (copied into site/)
.github/workflows/       auto-deploys site/ to GitHub Pages on every push to main
```

## Update the site after editing in Framer

You can keep designing in Framer. Publish there (the free framer.media address is fine), then:

```bash
SITE_URL=https://free10running.com node mirror.mjs   # set your real domain
git add -A && git commit -m "Update site" && git push
```

GitHub deploys the new version about a minute later. If the script prints
`WARNING: a Framer runtime patch did not match`, Framer has changed its code and the gallery may need a fix.

Preview locally before pushing: `npx serve site`, then open http://localhost:3000.

## One-time setup

1. **Create the repo.** On github.com, create a new repository (for example `free10running-site`). Then, in this folder:
   ```bash
   git init -b main
   git add -A
   git commit -m "Free10Running static site"
   git remote add origin https://github.com/<your-username>/free10running-site.git
   git push -u origin main
   ```
2. **Turn on Pages.** In the repo, go to Settings → Pages → Build and deployment and set Source to **GitHub Actions**.
   The first deploy runs automatically (you can watch it in the Actions tab).
3. **Add your domain.** In Settings → Pages → Custom domain, enter your domain (for example `free10running.com`) and save.
4. **Point DNS at GitHub** in your domain registrar's settings:
   - Apex domain (`free10running.com`): four `A` records to
     `185.199.108.153`, `185.199.109.153`, `185.199.110.153`, `185.199.111.153`
     (and optionally `AAAA` records to `2606:50c0:8000::153`, `2606:50c0:8001::153`, `2606:50c0:8002::153`, `2606:50c0:8003::153`)
   - `www`: a `CNAME` record to `<your-username>.github.io`
5. **Turn on HTTPS.** When DNS has propagated (minutes to a few hours), tick **Enforce HTTPS** in Settings → Pages.

## How the copy works

`mirror.mjs` downloads the five pages and every file they need, rewrites `https://framerusercontent.com/…` links to
`/assets/framerusercontent.com/…`, and patches Framer's runtime in three places:

- **Gallery data (CMS):** Framer's server returns parts of the CMS data file through a `?range=` query, which a static
  host can't do. The patched code downloads the whole file once and takes the parts it needs in the browser.
- **CMS image links** sit in binary files with byte offsets. They are replaced in place without changing their length
  (`https://` and `/assets/` are both 8 characters).
- **Removed:** Framer analytics, the on-page editor toolbar, and the "Made in Framer" badge.

The Google Maps embed on the Event page still loads from Google, which is expected.

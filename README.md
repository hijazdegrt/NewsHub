# Market hub

A personal news hub for Indian markets. It pulls exchange filings, RBI and SEBI
updates, FII/DII flows, market news, global cues and YouTube into one page that you can
open on any device.

- **Fetcher:** `fetcher/fetch.py` (Python) reads every source in `config/sources.yaml`,
  removes duplicates, tags each story, and writes `site/data/news.json`.
- **Page:** `site/` is plain HTML, CSS and JS built on [Oat](https://oat.ink) v1.1.0
  (copied into `site/vendor/oat`). You can install it to your home screen.
- **Schedule:** `.github/workflows/update.yml` runs the fetcher on GitHub Actions
  every 15 min from 7:30 to 16:45 IST on weekdays, and every hour at other times,
  then publishes `site/` to GitHub Pages. It costs nothing on a public repository.

## One-time setup on GitHub

1. Create a free account at github.com if you don't have one.
2. Create a new **public** repository (this one is `NewsHub`). Don't add a README.
3. Push this folder to it:
   ```
   git init -b main
   git add .
   git commit -m "Market hub"
   git remote add origin https://github.com/hijazdegrt/NewsHub.git
   git push -u origin main
   ```
4. On the repository page, open **Settings → Pages**. Under **Build and deployment →
   Source**, choose **GitHub Actions**.
5. Open the **Actions** tab, select **Update news**, and click **Run workflow**.
6. After about a minute the site is live at
   https://hijazdegrt.github.io/NewsHub/.
   On your phone, open that link and choose **Add to Home Screen**.

## Everyday changes

| To change | Edit |
|---|---|
| Your stocks | `config/watchlist.yaml` |
| News sources, snapshot symbols, quick links | `config/sources.yaml` |
| Tagging and priority rules | `EVENT_RULES`, `ROUTINE` and `tag()` in `fetcher/fetch.py` |
| Look and layout | `site/app.css`, `site/index.html` |

You can edit these files directly on github.com. Saving a change publishes it
within a couple of minutes. If you change `index.html`, `app.css` or `app.js`,
also bump `VERSION` in `site/sw.js` so installed copies pick up the change.

## Run it on your computer

```
pip install -r requirements.txt
python fetcher/fetch.py
python -m http.server 8765 --directory site
```

Then open http://localhost:8765.

## Good to know

- **Your watchlist is public**, because the repository has to be public for free GitHub Pages.
- **Updates can arrive 5 to 15 minutes late.** GitHub often starts scheduled jobs late.
- **Some sources may fail.** NSE, for example, may block GitHub's servers. Open **Source status** at the bottom of the menu to see what worked
  on the last run. One failing source doesn't stop the others.
- **Moneycontrol and SEBI come from Google News searches**, because their own RSS
  feeds stopped updating.
- **The market snapshot uses Yahoo Finance's unofficial data.** It is about 15 minutes
  delayed and could stop working without notice.
- **X and Instagram aren't included**, because they don't offer free access.
  Set your own X list address under `links` in `config/sources.yaml`.
- **Saved stories and read/unread marks stay on each device.** They don't sync.

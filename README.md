# What's Next

Shows your Goodreads **to-read** shelf with each book's Kindle membership status (kindle+, Kindle
Unlimited, Prime Reading) and Kindle price.

**Use the Chrome extension in [`extension/`](extension/)** — see its [README](extension/README.md) to
install. It refreshes your shelf and checks Amazon automatically in the background.

The rest of this repository is the earlier web-page version, kept for reference: a static page with
manual KU marks and a bookmarklet helper. It is no longer published or refreshed automatically.

## Earlier web-page version

- `scripts/fetch_shelf.py` reads your public Goodreads shelf through Goodreads' embeddable
  "custom widget" (the HTML snippet Goodreads offers for blogs). No login or API key needed.
  It writes `data/books.json`. Limit: newest 100 books on the shelf.
- Run it yourself to update `data/books.json` (see "Run locally" below).
- Amazon has no public API for Kindle Unlimited or Kindle prices and blocks automated checks, so
  KU status and price come from Amazon pages you open yourself:
  - **One-click helper (recommended):** open the "One-click Amazon helper" section on the page and drag
    **Save to What's Next** to your bookmarks bar. On a Kindle book's Amazon page, click it: it reads the KU
    badge and Kindle price from the page you're viewing, asks you to confirm, and saves them to your list.
    It only reads the page in your own browser and sends nothing anywhere except back to this page.
  - **By hand:** the **Free on KU / Paid…** buttons, with an optional price.
- Answers are saved in the browser. Use **Copy marks / Paste marks** to move them between devices, or put
  them in `data/ku.json` to make them the default everywhere, e.g.
  `{"8957018240": {"ku": "yes"}, "8905052539": {"ku": "no", "price": "$12.99"}}`
  (keys are the `id` values in `data/books.json`).
- The helper is set up for the address you install it from. If the page moves (e.g. from
  localhost to GitHub Pages), drag the button to your bookmarks bar again from the new address.

## Settings

Edit `config.json`:

- `goodreads_profile`: profile link, vanity name or numeric ID. The profile must be public.
- `shelf`: `to-read`, `currently-reading`, `read` or a custom shelf name.
- `amazon_store`: e.g. `www.amazon.com`.

## Run locally

```bash
python3 scripts/fetch_shelf.py
python3 -m http.server 8000
```

Then open http://localhost:8000.

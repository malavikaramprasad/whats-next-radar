# What's Next

A small page that shows your Goodreads **to-read** shelf and helps you track which books are in **Kindle Unlimited**.

## How it works

- `scripts/fetch_shelf.py` reads your public Goodreads shelf through Goodreads' embeddable
  "custom widget" (the HTML snippet Goodreads offers for blogs). No login or API key needed.
  It writes `data/books.json`. Limit: newest 100 books on the shelf.
- A GitHub Actions workflow runs it daily and publishes the page to GitHub Pages.
- Amazon has no public API for Kindle Unlimited or Kindle prices and blocks automated checks, so
  each book has a **Check on Amazon** link plus **Free on KU / Paid…** buttons. For paid books you
  can type the price you saw. Answers are saved in the browser. Use **Copy marks / Paste marks** to
  move them between devices, or put them in `data/ku.json` to make them the default everywhere,
  e.g. `{"8957018240": {"ku": "yes"}, "8905052539": {"ku": "no", "price": "12.99"}}`
  (keys are the `id` values in `data/books.json`).

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

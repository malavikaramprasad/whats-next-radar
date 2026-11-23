"""Fetch a public Goodreads shelf via the embeddable custom widget and write data/books.json.

Standard library only. Usage: python scripts/fetch_shelf.py
"""
import html
import json
import pathlib
import re
import sys
import time
import urllib.error
import urllib.request

ROOT = pathlib.Path(__file__).resolve().parent.parent
UA = {"User-Agent": "Mozilla/5.0 (compatible; whats-next-reader)"}


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def user_id(link):
    """Profile link, vanity name or numeric ID -> numeric Goodreads user ID."""
    link = link.strip().lstrip("@")
    if re.fullmatch(r"\d+", link):
        return link
    m = re.search(r"/user/show/(\d+)", link)
    if m:
        return m.group(1)
    name = link.rstrip("/").split("/")[-1]
    req = urllib.request.Request(f"https://www.goodreads.com/{name}", method="HEAD", headers=UA)
    try:
        urllib.request.build_opener(NoRedirect).open(req, timeout=30)
    except urllib.error.HTTPError as e:
        m = re.search(r"/user/show/(\d+)", e.headers.get("Location", ""))
        if e.code in (301, 302) and m:
            return m.group(1)
    return None


def shelf(uid, name="to-read"):
    """Newest 100 books on a public shelf (widget limit), as title/author dicts."""
    url = (f"https://www.goodreads.com/review/custom_widget/{uid}.x?num_books=100&order=d"
           f"&shelf={name}&show_author=1&show_cover=1&show_title=1&sort=date_added&widget_id=1")
    js = urllib.request.urlopen(urllib.request.Request(url, headers=UA), timeout=30).read().decode()
    text = js.replace('\\"', '"').replace("\\/", "/").replace("\\n", "\n").replace("\\'", "'")
    books = []
    # Each book sits in its own gr_custom_each_container_N block: cover, title, author.
    for block in re.split(r'<div class="gr_custom_each_container_', text)[1:]:
        t = re.search(r'class="gr_custom_title_\d+">\s*<a[^>]*href="([^"]*)"[^>]*>(.*?)</a>', block, re.S)
        a = re.search(r'class="gr_custom_author_\d+">\s*by <a[^>]*>(.*?)</a>', block, re.S)
        if not (t and a):
            continue
        cover = re.search(r'<img[^>]*src="([^"]*(?:gr-assets|goodreads)[^"]*/books/[^"]*)"', block)
        review = re.search(r"/review/show/(\d+)", t.group(1))
        title = html.unescape(t.group(2)).strip()
        author = re.sub(r"\s+", " ", html.unescape(a.group(1))).strip()
        books.append({
            "id": review.group(1) if review else f"{title}|{author}",
            "title": title,
            "author": author,
            "search_title": clean_title(title),
            "cover_source": cover.group(1).replace("._SY75_", "._SY180_") if cover else None,
            "goodreads_url": html.unescape(t.group(1)).split("?")[0],
        })
    return books


def clean_title(title):
    """Drop '(Series, #1)' and long subtitles so store searches match."""
    t = re.sub(r"\s*\([^)]*#\d[^)]*\)\s*$", "", title)
    t = t.split(":")[0]
    return t.strip()


def save_covers(books):
    """Download covers into covers/ so the page serves its own copies.

    Some hosts (and previews) block images from other sites; local files always load.
    Existing files are reused, and covers for books no longer on the shelf are removed.
    """
    folder = ROOT / "covers"
    folder.mkdir(exist_ok=True)
    keep = set()
    for b in books:
        b["cover"] = None
        src = b.pop("cover_source", None)
        if not src:
            continue
        name = re.sub(r"[^\w-]", "_", b["id"]) + ".jpg"
        path = folder / name
        if not path.exists():
            try:
                data = urllib.request.urlopen(urllib.request.Request(src, headers=UA), timeout=30).read()
                path.write_bytes(data)
                time.sleep(0.5)  # be gentle with Goodreads' image server
            except (urllib.error.URLError, TimeoutError) as e:
                print(f"Cover download failed for {b['title']!r}: {e}", file=sys.stderr)
                continue
        b["cover"] = f"covers/{name}"
        keep.add(name)
    for old in folder.glob("*.jpg"):
        if old.name not in keep:
            old.unlink()


def main():
    cfg = json.loads((ROOT / "config.json").read_text())
    uid = user_id(cfg["goodreads_profile"])
    if not uid:
        sys.exit(f"Could not find a Goodreads user for {cfg['goodreads_profile']!r}")
    books = shelf(uid, cfg.get("shelf", "to-read"))
    if not books:
        sys.exit("Shelf came back empty - is the Goodreads profile public?")
    save_covers(books)
    out = {
        "fetched_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "goodreads_user_id": uid,
        "shelf": cfg.get("shelf", "to-read"),
        "amazon_store": cfg.get("amazon_store", "www.amazon.com"),
        "books": books,
    }
    (ROOT / "data").mkdir(exist_ok=True)
    (ROOT / "data" / "books.json").write_text(json.dumps(out, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(books)} books from user {uid}")


if __name__ == "__main__":
    main()

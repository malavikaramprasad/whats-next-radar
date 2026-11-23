// Shared logic: reading the Goodreads shelf and checking Amazon's Kindle store.
// Everything runs inside the person's own Chrome, with their own Goodreads and Amazon sessions.
// Loaded by the offscreen document (which does the fetching and parsing) and by the dashboard.

const AMAZON = "https://www.amazon.com";
const GOODREADS = "https://www.goodreads.com";

class AmazonBlocked extends Error {}

// ---------- text helpers ----------
function cleanText(s) {
  return (s || "").replace(/\s+/g, " ").trim();
}
function decodeEntities(s) {
  const t = document.createElement("textarea");
  t.innerHTML = s;
  return t.value;
}
// For matching titles across sites: lower-case, no accents, no "(Series #1)", no subtitle, no articles.
function simplify(s) {
  return (s || "").toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/\([^)]*\)|\[[^\]]*\]/g, " ").split(":")[0]
    .replace(/&/g, " and ").replace(/[^a-z0-9 ]/g, " ").replace(/\b(the|a|an)\b/g, " ")
    .replace(/\s+/g, " ").trim();
}
function searchTitle(title) {
  return title.replace(/\s*\([^)]*#\d[^)]*\)\s*$/, "").split(":")[0].trim();
}

// ---------- Goodreads ----------
// Profile link, vanity name or numeric ID -> numeric user ID.
async function goodreadsUserId(link) {
  link = (link || "").trim().replace(/^@/, "");
  if (/^\d+$/.test(link)) return link;
  let m = link.match(/\/user\/show\/(\d+)/);
  if (m) return m[1];
  const name = link.replace(/\/+$/, "").split("/").pop();
  if (!name) return null;
  // Goodreads redirects /<name> to /user/show/<id>-<name>; the final address holds the ID.
  const res = await fetch(`${GOODREADS}/${encodeURIComponent(name)}`, { credentials: "include" });
  m = res.url.match(/\/user\/show\/(\d+)/);
  return m ? m[1] : null;
}

// Newest 100 books on a shelf, via Goodreads' embeddable shelf widget.
async function goodreadsShelf(uid, shelf = "to-read") {
  const url = `${GOODREADS}/review/custom_widget/${uid}.x?num_books=100&order=d` +
    `&shelf=${encodeURIComponent(shelf)}&show_author=1&show_cover=1&show_title=1&sort=date_added&widget_id=1`;
  const res = await fetch(url, { credentials: "include" });
  if (!res.ok) throw new Error(`Goodreads answered ${res.status}`);
  const js = await res.text();
  const text = js.replace(/\\"/g, '"').replace(/\\\//g, "/").replace(/\\n/g, "\n").replace(/\\'/g, "'");
  const books = [];
  for (const block of text.split('<div class="gr_custom_each_container_').slice(1)) {
    const t = block.match(/class="gr_custom_title_\d+">\s*<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/);
    const a = block.match(/class="gr_custom_author_\d+">\s*by <a[^>]*>([\s\S]*?)<\/a>/);
    if (!t || !a) continue;
    const cover = block.match(/<img[^>]*src="([^"]*\/books\/[^"]*)"/);
    const review = t[1].match(/\/review\/show\/(\d+)/);
    const title = cleanText(decodeEntities(t[2]));
    const author = cleanText(decodeEntities(a[1]));
    books.push({
      id: review ? review[1] : `${title}|${author}`,
      title, author,
      cover: cover ? cover[1].replace("._SY75_", "._SY180_") : null,
      goodreadsUrl: decodeEntities(t[1]).split("?")[0],
    });
  }
  return books;
}

// ---------- Amazon ----------
function amazonSearchUrl(book) {
  return `${AMAZON}/s?k=${encodeURIComponent(searchTitle(book.title) + " " + book.author)}&i=digital-text`;
}

const MONEY = /(?:US\$|\$)\s?\d[\d,]*(?:\.\d{2})?/g;
const isZero = (p) => /^\D*0+(\.0+)?$/.test(p.replace(/\s/g, ""));

// Reads one search result: title, ASIN, KU status and Kindle price.
function readResult(r) {
  const h2 = r.querySelector("h2");
  const title = cleanText(h2 ? (h2.getAttribute("aria-label") || h2.textContent) : "");
  const asin = r.getAttribute("data-asin");
  const text = cleanText(r.textContent);
  const ku = /Kindle\s*Unlimited/i.test(text) &&
    /(\$0\.00|Read for Free|Free with Kindle Unlimited|Read with Kindle Unlimited|Kindle Unlimited\s*\$0)/i.test(text);
  let price = "";
  const buy = text.match(/Or\s+((?:US\$|\$)\s?\d[\d,]*\.\d{2})\s+to buy/i);
  if (buy) price = buy[1];
  if (!price) {
    for (const el of r.querySelectorAll(".a-price .a-offscreen")) {
      const p = (cleanText(el.textContent).match(MONEY) || [])[0];
      if (p && !isZero(p)) { price = p; break; }
    }
  }
  if (!price) price = ((text.match(MONEY) || []).find((p) => !isZero(p))) || "";
  const author = cleanText((r.querySelector(".a-row.a-size-base.a-color-secondary") || {}).textContent || "");
  return { title, asin, ku, price, author, sponsored: /\bSponsored\b/.test(text) };
}

// Checks one book on Amazon. Returns { status: "yes" | "no" | "notfound", price, asin, url, amazonTitle }.
async function checkAmazon(book) {
  const res = await fetch(amazonSearchUrl(book), { credentials: "include" });
  const html = await res.text();
  if (res.status === 503 || /validateCaptcha|api-services-support@amazon\.com|Type the characters you see/i.test(html)) {
    throw new AmazonBlocked("Amazon asked for a CAPTCHA");
  }
  if (!res.ok) throw new Error(`Amazon answered ${res.status}`);
  const doc = new DOMParser().parseFromString(html, "text/html");
  const results = [...doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
    .filter((r) => r.getAttribute("data-asin")).map(readResult);
  const want = simplify(searchTitle(book.title));
  const surname = simplify(book.author).split(" ").pop() || "";
  let best = null, bestScore = 0;
  for (const r of results) {
    const got = simplify(r.title);
    let score = 0;
    if (got && got === want) score = 3;
    else if (got && want && (got.startsWith(want) || want.startsWith(got))) score = 2;
    if (!score) continue;
    if (surname && simplify(r.author || r.title).includes(surname)) score += 1;
    if (r.sponsored) score -= 0.5;
    if (score > bestScore) { best = r; bestScore = score; }
  }
  if (!best || bestScore < 2) return { status: "notfound", checkedAt: Date.now() };
  return {
    status: best.ku ? "yes" : "no",
    price: best.price || "",
    asin: best.asin,
    url: `${AMAZON}/dp/${best.asin}`,
    amazonTitle: best.title,
    checkedAt: Date.now(),
  };
}

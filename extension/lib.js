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
// Bump when the way Amazon pages are read changes: every saved result is then re-checked.
const PARSER_VERSION = 3;

// Hoopla (library app): a search link only. Hoopla has no public API, so availability isn't checked here.
function hooplaSearchUrl(book) {
  return `https://www.hoopladigital.com/search?q=${encodeURIComponent(searchTitle(book.title) + " " + book.author)}&type=direct`;
}

function amazonSearchUrl(book) {
  return `${AMAZON}/s?k=${encodeURIComponent(searchTitle(book.title) + " " + book.author)}&i=digital-text`;
}

const MONEY = /(?:US\$|\$)\s?\d[\d,]*(?:\.\d{2})?/g;
const isZero = (p) => /^\D*0+(\.0+)?$/.test(p.replace(/\s/g, ""));
const KU_MARK = '[class*="kindle-unlimited" i], [class*="kindleunlimited" i], img[alt*="Kindle Unlimited" i], ' +
  '[aria-label*="Kindle Unlimited" i], [id*="kindle-unlimited" i], [id*="kindleunlimited" i], #borrow-button, [id*="borrow" i]';
// Amazon's newer "kindle+" membership logo.
const KPLUS_MARK = '[class*="kindle-plus" i], [class*="kindleplus" i], [class*="kindle_plus" i], img[alt*="kindle+" i], ' +
  'img[alt*="kindle plus" i], [aria-label*="kindle+" i], [aria-label*="kindle plus" i], img[src*="kindle-plus" i], img[src*="kindleplus" i], img[src*="kindle_plus" i]';
const KPLUS_WORDS = /kindle\s*\+|kindle\s*plus/i;
// Wording Amazon only shows when the book is free to read for you.
const INCLUDED = /(Included with your\s*(kindle\s*\+|kindle\s*plus|kindle unlimited|prime)?\s*membership|Add to library)/i;
const PRIME_MARK = '[class*="prime-reading" i], img[alt*="Prime Reading" i], [aria-label*="Prime Reading" i]';
const FREE_WORDS = /(Read for Free|Read for \$0(\.00)?|Read now for free|Read with Kindle Unlimited|Read now with Kindle Unlimited|Free with Kindle Unlimited|Borrow for Free|Read with Prime|Free with Prime|\$0\.00\s*(with|on|Kindle Unlimited|Prime))/i;
const isAudio = (s) => /audible|audiobook|audio cd|listen/i.test(s);

function blockedPage(res, html) {
  return res.status === 503 || /validateCaptcha|api-services-support@amazon\.com|Type the characters you see/i.test(html);
}
async function getPage(url) {
  const res = await fetch(url, { credentials: "include" });
  const html = await res.text();
  if (blockedPage(res, html)) throw new AmazonBlocked("Amazon asked for a CAPTCHA");
  if (!res.ok) throw new Error(`Amazon answered ${res.status}`);
  return new DOMParser().parseFromString(html, "text/html");
}

// One search result: title, ASIN and what it shows about KU and price.
function readResult(r) {
  const h2 = r.querySelector("h2");
  const title = cleanText(h2 ? (h2.getAttribute("aria-label") || h2.textContent) : "");
  const text = cleanText(r.textContent);
  const kuMark = !!r.querySelector(KU_MARK) || /Kindle\s*Unlimited/i.test(text);
  const primeMark = !!r.querySelector(PRIME_MARK) || /Prime Reading/i.test(text);
  const kplusMark = !!r.querySelector(KPLUS_MARK) || KPLUS_WORDS.test(text);
  // A $0.00 price counts only if it isn't the Audible trial line.
  const zero = [...r.querySelectorAll(".a-price .a-offscreen")].some((e) =>
    isZero(cleanText(e.textContent)) && !isAudio(cleanText((e.closest(".a-row, div") || e).textContent)));
  const free = INCLUDED.test(text) || ((kuMark || primeMark || kplusMark) && (zero || FREE_WORDS.test(text)));
  const buy = text.match(/Or\s+((?:US\$|\$)\s?\d[\d,]*\.\d{2})\s+to buy/i);
  let price = buy ? buy[1] : "";
  if (!price) for (const e of r.querySelectorAll(".a-price .a-offscreen")) {
    const p = (cleanText(e.textContent).match(MONEY) || [])[0];
    if (p && !isZero(p)) { price = p; break; }
  }
  const author = cleanText((r.querySelector(".a-row.a-size-base.a-color-secondary") || {}).textContent || "");
  return { title, asin: r.getAttribute("data-asin"), author, free, kuMark, primeMark, kplusMark, price,
    sponsored: /\bSponsored\b/.test(text), evidence: text.slice(0, 300) };
}

// The Kindle edition's own page: the most reliable place to see "$0.00 / Included with your membership".
// Amazon changes this layout often, so it reads short bits of text from the whole page (minus the
// description, reviews, ads and recommendations) rather than relying on particular element IDs.
function readProductPage(doc) {
  for (const junk of doc.querySelectorAll("script, style, noscript, #bookDescription_feature_div, #productDescription, " +
    "#editorialReviews_feature_div, #customerReviews, #reviewsMedley, [id*='sims'], [id*='carousel' i], " +
    "[id^='ad-' i], [id^='ad_' i], [id*='sponsored' i], [class*='sponsored' i], [data-ad-details], #nav-main, #navbar, #navFooter")) junk.remove();
  const title = cleanText((doc.querySelector("#productTitle, #ebooksProductTitle") || {}).textContent || "");
  const textOf = (e) => cleanText(e.textContent || e.getAttribute("value") || e.getAttribute("alt") || e.getAttribute("aria-label") || "");
  const body = doc.body || doc.documentElement;

  // Short bits of text, leaving out Audible upsells and long paragraphs.
  const pieces = [];
  for (const e of body.querySelectorAll("span, a, div, button, input, i, img, p, h2, h3, h4")) {
    if (e.children.length > 3) continue;
    const t = textOf(e);
    if (t && t.length <= 160 && !isAudio(t)) pieces.push(t);
  }
  const text = [...new Set(pieces)].join(" | ");

  // The Kindle format tile, e.g. "Kindle $0.00 kindle+ or $12.99 to buy".
  const tiles = [...body.querySelectorAll("#tmm-grid-swatch-KINDLE, #tmm-grid-swatch-KINDLE_EBOOK, #tmmSwatches .selected, li, div, a, span")]
    .map((e) => ({ e, t: cleanText(e.textContent) }))
    .filter(({ t }) => /^Kindle\b(?!\s*Unlimited)/i.test(t) && t.length <= 150 && /\$\s?\d/.test(t) && !isAudio(t))
    .sort((a, b) => a.t.length - b.t.length);
  const tile = tiles[0] ? tiles[0].t : cleanText((doc.querySelector("#kindle-price") || {}).textContent || "");
  const tileFirstPrice = (tile.match(MONEY) || [])[0];
  const zeroKindle = !!tileFirstPrice && isZero(tileFirstPrice);

  const marks = (sel) => [...body.querySelectorAll(sel)].some((e) => !isAudio(cleanText((e.parentElement || e).textContent)));
  const kuMark = marks(KU_MARK) || /Kindle\s*Unlimited/i.test(text);
  const primeMark = marks(PRIME_MARK) || /Prime Reading/i.test(text);
  const kplusMark = marks(KPLUS_MARK) || KPLUS_WORDS.test(text);
  const free = zeroKindle || INCLUDED.test(text) || ((kuMark || primeMark || kplusMark) && FREE_WORDS.test(text));

  // Price to buy: "or $12.99 to buy" on the Kindle tile first, then the buy box wording.
  const BUY = /(?:\bor|\bBuy(?: now)?(?: with 1-Click)?(?: for)?|Kindle Price:?)\s*(?:\|\s*)?((?:US\$|\$)\s?\d[\d,]*\.\d{2})/i;
  const buyIn = (t) => { const m = (t || "").match(BUY); return m && !isZero(m[1]) ? m[1] : ""; };
  const price = buyIn(tile) || (tileFirstPrice && !isZero(tileFirstPrice) ? tileFirstPrice : "") || buyIn(text);
  const evidence = [tile && `Kindle tile: ${tile}`, (text.match(INCLUDED) || [])[0] && `Buy box: ${text.match(INCLUDED)[0]}`]
    .filter(Boolean).join(" · ") || text.slice(0, 400);
  return { title, free, kuMark, primeMark, kplusMark, price, evidence: evidence.slice(0, 400) };
}

function program(r) {
  return r.kplusMark ? "Kindle+" : r.kuMark ? "Kindle Unlimited" : r.primeMark ? "Prime Reading" : "your membership";
}

// Checks one book. Returns { status: "yes" | "no" | "notfound", via, price, asin, url, ... }.
// `known` is the previous result, so a book's Kindle edition is only searched for once.
async function checkAmazon(book, known) {
  let asin = known && known.asin, amazonTitle = known && known.amazonTitle, fromSearch = null;
  if (!asin) {
    const doc = await getPage(amazonSearchUrl(book));
    const results = [...doc.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
      .filter((r) => r.getAttribute("data-asin")).map(readResult);
    const want = simplify(searchTitle(book.title));
    const surname = simplify(book.author).split(" ").pop() || "";
    let bestScore = 0;
    for (const r of results) {
      const got = simplify(r.title);
      let score = 0;
      if (got && got === want) score = 3;
      else if (got && want && (got.startsWith(want) || want.startsWith(got))) score = 2;
      if (!score) continue;
      if (surname && simplify(r.author || r.title).includes(surname)) score += 1;
      if (r.sponsored) score -= 0.5;
      if (score > bestScore) { fromSearch = r; bestScore = score; }
    }
    if (!fromSearch || bestScore < 2) return { status: "notfound", checkedAt: Date.now(), v: PARSER_VERSION };
    asin = fromSearch.asin; amazonTitle = fromSearch.title;
  }
  const url = `${AMAZON}/dp/${asin}`;
  let page = null;
  try {
    page = readProductPage(await getPage(url));
    if (!page.title) page = null; // not a product page layout we know
  } catch (e) {
    if (e instanceof AmazonBlocked || !fromSearch) throw e;
  }
  const r = page || fromSearch;
  if (!r) throw new Error("Couldn't read the Kindle page");
  return {
    status: r.free ? "yes" : "no",
    via: r.free ? program(r) : "",
    price: r.price || "",
    asin, url, amazonTitle: (page && page.title) || amazonTitle,
    source: page ? "book page" : "search results",
    evidence: r.evidence,
    checkedAt: Date.now(),
    v: PARSER_VERSION,
  };
}

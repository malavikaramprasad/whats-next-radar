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
const PARSER_VERSION = 2;

function amazonSearchUrl(book) {
  return `${AMAZON}/s?k=${encodeURIComponent(searchTitle(book.title) + " " + book.author)}&i=digital-text`;
}

const MONEY = /(?:US\$|\$)\s?\d[\d,]*(?:\.\d{2})?/g;
const isZero = (p) => /^\D*0+(\.0+)?$/.test(p.replace(/\s/g, ""));
const KU_MARK = '[class*="kindle-unlimited" i], [class*="kindleunlimited" i], img[alt*="Kindle Unlimited" i], ' +
  '[aria-label*="Kindle Unlimited" i], [id*="kindle-unlimited" i], [id*="kindleunlimited" i], #borrow-button, [id*="borrow" i]';
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
  // A $0.00 price counts only if it isn't the Audible trial line.
  const zero = [...r.querySelectorAll(".a-price .a-offscreen")].some((e) =>
    isZero(cleanText(e.textContent)) && !isAudio(cleanText((e.closest(".a-row, div") || e).textContent)));
  const free = (kuMark || primeMark) && (zero || FREE_WORDS.test(text));
  const buy = text.match(/Or\s+((?:US\$|\$)\s?\d[\d,]*\.\d{2})\s+to buy/i);
  let price = buy ? buy[1] : "";
  if (!price) for (const e of r.querySelectorAll(".a-price .a-offscreen")) {
    const p = (cleanText(e.textContent).match(MONEY) || [])[0];
    if (p && !isZero(p)) { price = p; break; }
  }
  const author = cleanText((r.querySelector(".a-row.a-size-base.a-color-secondary") || {}).textContent || "");
  return { title, asin: r.getAttribute("data-asin"), author, free, kuMark, primeMark, price,
    sponsored: /\bSponsored\b/.test(text), evidence: text.slice(0, 300) };
}

// The Kindle edition's own page: the most reliable place to see "$0.00 / Read for Free".
function readProductPage(doc) {
  for (const junk of doc.querySelectorAll("script, style, noscript, #bookDescription_feature_div, #productDescription, " +
    "#editorialReviews_feature_div, #customerReviews, #reviewsMedley, [id*='sims'], [id*='carousel' i]")) junk.remove();
  const title = cleanText((doc.querySelector("#productTitle, #ebooksProductTitle") || {}).textContent || "");
  const swatch = doc.querySelector("#tmm-grid-swatch-KINDLE, #tmm-grid-swatch-KINDLE_EBOOK, .swatchElement.selected, #tmmSwatches .selected");
  const zones = [swatch, ...doc.querySelectorAll("#buybox, #rightCol, #corePriceDisplay_desktop_feature_div, #kindle-price, #formats, #tmmSwatches, #buyBoxAccordion")]
    .filter(Boolean);
  // Text of the buying areas, leaving out Audible upsells.
  const pieces = [];
  for (const z of zones) for (const e of z.querySelectorAll("span, a, div, button, input, i, img")) {
    if (e.children.length > 3) continue;
    const t = cleanText(e.textContent || e.getAttribute("value") || e.getAttribute("alt") || e.getAttribute("aria-label") || "");
    if (t && !isAudio(t)) pieces.push(t);
  }
  const text = [...new Set(pieces)].join(" | ");
  const marks = (sel) => zones.some((z) => [...z.querySelectorAll(sel)].some((e) => !isAudio(cleanText((e.parentElement || e).textContent))));
  const kuMark = marks(KU_MARK) || /Kindle\s*Unlimited/i.test(text);
  const primeMark = marks(PRIME_MARK) || /Prime Reading/i.test(text);
  const kindlePrice = cleanText((doc.querySelector("#kindle-price") || {}).textContent || "") ||
    cleanText(((swatch && swatch.querySelector(".slot-price, .a-color-price, .a-price .a-offscreen")) || {}).textContent || "");
  const zeroKindle = !!kindlePrice && isZero((kindlePrice.match(MONEY) || ["x"])[0]);
  const free = zeroKindle || ((kuMark || primeMark) && FREE_WORDS.test(text));
  let price = "";
  const buy = text.match(/(?:Or|Buy(?: now)?(?: with 1-Click)?(?: for)?|Kindle Price:?)\s*((?:US\$|\$)\s?\d[\d,]*\.\d{2})(?:\s+to buy)?/i);
  if (buy && !isZero(buy[1])) price = buy[1];
  if (!price) price = (text.match(MONEY) || []).find((p) => !isZero(p)) || "";
  return { title, free, kuMark, primeMark, price, evidence: text.slice(0, 400) };
}

function program(r) {
  return r.kuMark ? "Kindle Unlimited" : r.primeMark ? "Prime Reading" : "your membership";
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

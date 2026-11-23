// The What's Next tab: shows the shelf and keeps Kindle details up to date.
const DEFAULTS = { profile: "https://www.goodreads.com/user/show/176924243-malavika-ramprasad", shelf: "to-read" };
const SHELF_MAX_AGE = 12 * 3600e3;      // re-read Goodreads after 12 hours
const KINDLE_MAX_AGE = 7 * 24 * 3600e3; // re-check a book on Amazon after a week
const PAUSE_MS = 2500;                  // gap between Amazon requests

let state = { settings: { ...DEFAULTS }, books: [], booksFetchedAt: 0, kindle: {} };
let filter = "all", query = "", checking = null, running = false, blocked = false;

const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function load() {
  const saved = await chrome.storage.local.get(["settings", "books", "booksFetchedAt", "kindle"]);
  state = {
    settings: { ...DEFAULTS, ...(saved.settings || {}) },
    books: saved.books || [],
    booksFetchedAt: saved.booksFetchedAt || 0,
    kindle: saved.kindle || {},
  };
}
const save = (part) => chrome.storage.local.set(part);

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) n.append(k);
  return n;
}
function setStatus(content, warn) {
  const s = $("status");
  if (!content) { s.hidden = true; return; }
  s.replaceChildren(...[].concat(content));
  s.className = "status" + (warn ? " warn" : "");
  s.hidden = false;
}
function ago(t) {
  if (!t) return "";
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h} h ago`;
  return `${Math.round(h / 24)} days ago`;
}

function kindleState(b) {
  if (checking === b.id) return "checking";
  const k = state.kindle[b.id];
  return k ? k.status : "unchecked";
}

function render() {
  const list = $("list");
  const q = query.toLowerCase();
  const shown = state.books.filter((b) => {
    const s = kindleState(b);
    if (filter === "yes" && s !== "yes") return false;
    if (filter === "no" && s !== "no") return false;
    if (filter === "other" && (s === "yes" || s === "no")) return false;
    return !q || `${b.title} ${b.author}`.toLowerCase().includes(q);
  });
  list.replaceChildren(...shown.map(card));
  if (!shown.length) list.append(el("li", { class: "empty" }, state.books.length ? "No books match." : "No books yet."));

  const n = (s) => state.books.filter((b) => kindleState(b) === s).length;
  $("sub").textContent = state.books.length
    ? `${state.books.length} books to read · ${n("yes")} free on KU · ${n("no")} paid` +
      (n("notfound") ? ` · ${n("notfound")} not on Kindle` : "") +
      (n("unchecked") + n("error") ? ` · ${n("unchecked") + n("error")} not checked yet` : "") +
      (state.booksFetchedAt ? ` · shelf updated ${ago(state.booksFetchedAt)}` : "")
    : "Loading your Goodreads shelf…";
}

function card(b) {
  const s = kindleState(b), k = state.kindle[b.id] || {};
  const label = {
    yes: "✓ Free to read", no: "Paid (not in KU)", notfound: "Not found on Kindle",
    checking: "Checking Amazon…", unchecked: "Not checked yet", error: "Couldn't check",
  }[s];
  const priceText =
    s === "yes" ? (k.price ? `Free with KU · ${k.price} to buy` : "Free with KU") :
    s === "no" ? (k.price || "Price not shown") :
    s === "notfound" ? "No Kindle edition found" : "—";
  const amazonLink = k.url || amazonSearchUrl(b);
  return el("li", { "data-id": b.id },
    b.cover ? el("img", { src: b.cover, alt: "", loading: "lazy" }) : el("div", { class: "nocover" }),
    el("div", {},
      el("p", { class: "title" }, el("a", { href: b.goodreadsUrl, target: "_blank", rel: "noopener" }, b.title)),
      el("p", { class: "author" }, b.author),
      el("dl", { class: "details" },
        el("div", {}, el("dt", {}, "Kindle Unlimited"), el("dd", {}, el("span", { class: `badge ${s}` }, label))),
        el("div", {}, el("dt", {}, "Kindle price"), el("dd", { class: s === "no" && k.price ? "price-value" : "muted" }, priceText))),
      el("div", { class: "row" },
        el("a", { href: amazonLink, target: "_blank", rel: "noopener" }, k.url ? "Open on Amazon ↗" : "Search Amazon ↗"),
        k.checkedAt ? el("span", { class: "muted" }, `checked ${ago(k.checkedAt)}`) : null,
        s !== "checking" ? el("button", { on: { click: () => checkBooks([b], true) } }, "Check again") : null)));
}

async function refreshShelf() {
  setStatus("Reading your Goodreads shelf…");
  try {
    const uid = await goodreadsUserId(state.settings.profile);
    if (!uid) throw new Error(`Couldn't find the Goodreads profile “${state.settings.profile}”. Check Settings.`);
    const books = await goodreadsShelf(uid, state.settings.shelf || "to-read");
    if (!books.length) throw new Error("The shelf came back empty. Is the Goodreads profile public, and is the shelf name right?");
    state.books = books;
    state.booksFetchedAt = Date.now();
    await save({ books, booksFetchedAt: state.booksFetchedAt });
    setStatus(null);
  } catch (e) {
    setStatus(`Goodreads: ${e.message}`, true);
  }
  render();
}

async function checkBooks(books, force) {
  if (running) return;
  const todo = books.filter((b) => {
    if (force) return true;
    const k = state.kindle[b.id];
    return !k || k.status === "error" || Date.now() - (k.checkedAt || 0) > KINDLE_MAX_AGE;
  });
  if (!todo.length) return;
  running = true; blocked = false;
  $("refresh").disabled = true;
  for (let i = 0; i < todo.length; i++) {
    const b = todo[i];
    checking = b.id; render();
    if (todo.length > 1) setStatus(`Checking Amazon: ${i + 1} of ${todo.length} — ${b.title}`);
    try {
      state.kindle[b.id] = await checkAmazon(b);
    } catch (e) {
      if (e instanceof AmazonBlocked) {
        blocked = true;
        checking = null;
        setStatus([
          "Amazon asked for a CAPTCHA, so checking stopped. ",
          el("a", { href: "https://www.amazon.com/s?k=kindle+unlimited&i=digital-text", target: "_blank", rel: "noopener" }, "Open Amazon"),
          ", complete the check if it shows one, then press Refresh here.",
        ], true);
        break;
      }
      state.kindle[b.id] = { status: "error", error: e.message, checkedAt: 0 };
    }
    await save({ kindle: state.kindle });
    checking = null; render();
    if (i < todo.length - 1) await sleep(PAUSE_MS);
  }
  if (!blocked) setStatus(null);
  running = false;
  $("refresh").disabled = false;
  render();
}

async function refreshAll(forceShelf) {
  if (running) return;
  if (forceShelf || !state.books.length || Date.now() - state.booksFetchedAt > SHELF_MAX_AGE) await refreshShelf();
  await checkBooks(state.books, false);
}

// ---------- events ----------
document.querySelectorAll(".filters button").forEach((btn) => btn.addEventListener("click", () => {
  filter = btn.dataset.f;
  document.querySelectorAll(".filters button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
  render();
}));
$("q").addEventListener("input", (e) => { query = e.target.value; render(); });
$("refresh").addEventListener("click", () => refreshAll(true));
$("settingsBtn").addEventListener("click", () => {
  const f = $("settings"); f.hidden = !f.hidden;
  $("settingsBtn").setAttribute("aria-expanded", String(!f.hidden));
  $("profile").value = state.settings.profile; $("shelf").value = state.settings.shelf;
});
$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  state.settings = { profile: $("profile").value.trim() || DEFAULTS.profile, shelf: $("shelf").value.trim() || DEFAULTS.shelf };
  await save({ settings: state.settings });
  $("settings").hidden = true;
  refreshAll(true);
});

(async () => {
  await load();
  render();
  refreshAll(false);
})();

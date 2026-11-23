// The What's Next tab: a live view of what the background has saved.
// All fetching happens in the background (background.js), so this tab never needs to stay open.
const DEFAULTS = { profile: "https://www.goodreads.com/user/show/176924243-malavika-ramprasad", shelf: "to-read" };

let state = { settings: { ...DEFAULTS }, books: [], booksFetchedAt: 0, kindle: {}, job: {}, unseen: [], justSeen: [] };
let filter = "all", query = "";

const $ = (id) => document.getElementById(id);
const tell = (msg) => chrome.runtime.sendMessage({ target: "background", ...msg }).catch(() => {});

async function load() {
  const saved = await chrome.storage.local.get(["settings", "books", "booksFetchedAt", "kindle", "job", "unseen", "justSeen"]);
  state = {
    settings: { ...DEFAULTS, ...(saved.settings || {}) },
    books: saved.books || [],
    booksFetchedAt: saved.booksFetchedAt || 0,
    kindle: saved.kindle || {},
    job: saved.job || {},
    unseen: saved.unseen || [],
    justSeen: saved.justSeen || [],
  };
}

function el(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "on") for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== undefined) n.append(k);
  return n;
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
const isNew = (id) => state.unseen.includes(id) || state.justSeen.includes(id);

function kindleState(b) {
  if (state.job.running && (state.job.checking || []).includes(b.id)) return "checking";
  const k = state.kindle[b.id];
  return k ? k.status : "unchecked";
}

function renderStatus() {
  const s = $("status"), j = state.job;
  let content = null, warn = false;
  if (j.running && j.phase === "shelf") content = "Reading your Goodreads shelf…";
  else if (j.running && j.total) content = `Checking Amazon: ${j.done || 0} of ${j.total} books done…`;
  else if (j.blocked) {
    warn = true;
    content = [
      "Amazon asked for a CAPTCHA, so checking stopped. ",
      el("a", { href: "https://www.amazon.com/s?k=kindle+unlimited&i=digital-text", target: "_blank", rel: "noopener" }, "Open Amazon"),
      ", complete the check if it shows one, then press Refresh here.",
    ];
  } else if (j.error) { warn = true; content = j.error; }
  if (!content) { s.hidden = true; return; }
  s.replaceChildren(...[].concat(content));
  s.className = "status" + (warn ? " warn" : "");
  s.hidden = false;
}

function render() {
  renderStatus();
  $("refresh").disabled = !!state.job.running;
  const list = $("list");
  const q = query.toLowerCase();
  const shown = state.books.filter((b) => {
    const s = kindleState(b);
    if (filter === "yes" && s !== "yes") return false;
    if (filter === "no" && s !== "no") return false;
    if (filter === "other" && (s === "yes" || s === "no")) return false;
    return !q || `${b.title} ${b.author}`.toLowerCase().includes(q);
  });
  // Free on KU first, then paid, then the rest. Within each group, keep the Goodreads order (newest first).
  // Sort by the saved result, not "Checking…", so cards don't jump around during a re-check.
  const rank = (b) => ({ yes: 0, no: 1 }[(state.kindle[b.id] || {}).status] ?? 2);
  shown.sort((a, b) => rank(a) - rank(b));
  list.replaceChildren(...shown.map(card));
  if (!shown.length) list.append(el("li", { class: "empty" }, state.books.length ? "No books match." : "Loading your Goodreads shelf…"));

  const n = (s) => state.books.filter((b) => kindleState(b) === s).length;
  const fresh = state.books.filter((b) => isNew(b.id)).length;
  $("sub").textContent = state.books.length
    ? `${state.books.length} books to read` + (fresh ? ` (${fresh} new)` : "") +
      ` · ${n("yes")} free on KU · ${n("no")} paid` +
      (n("notfound") ? ` · ${n("notfound")} not on Kindle` : "") +
      (n("unchecked") + n("error") ? ` · ${n("unchecked") + n("error")} not checked yet` : "") +
      (state.booksFetchedAt ? ` · shelf updated ${ago(state.booksFetchedAt)}` : "")
    : "Loading…";
}

function card(b) {
  const s = kindleState(b), k = state.kindle[b.id] || {};
  const label = {
    yes: k.via ? `✓ Free with ${k.via}` : "✓ Free to read", no: "Paid (not in KU)", notfound: "Not found on Kindle",
    checking: "Checking Amazon…", unchecked: "Not checked yet", error: "Couldn't check",
  }[s];
  const priceText =
    s === "yes" ? (k.price ? `$0.00 for you · ${k.price} to buy` : "$0.00 for you") :
    s === "no" ? (k.price || "Price not shown") :
    s === "notfound" ? "No Kindle edition found" : "—";
  return el("li", { "data-id": b.id },
    b.cover ? el("img", { src: b.cover, alt: "", loading: "lazy" }) : el("div", { class: "nocover" }),
    el("div", {},
      el("p", { class: "title" },
        isNew(b.id) ? el("span", { class: "new" }, "New") : null,
        el("a", { href: b.goodreadsUrl, target: "_blank", rel: "noopener" }, b.title)),
      el("p", { class: "author" }, b.author),
      el("dl", { class: "details" },
        el("div", {}, el("dt", {}, "Kindle Unlimited"), el("dd", {}, el("span", { class: `badge ${s}` }, label))),
        el("div", {}, el("dt", {}, "Kindle price"), el("dd", { class: s === "no" && k.price ? "price-value" : "muted" }, priceText))),
      el("div", { class: "row" },
        el("a", { href: k.url || amazonSearchUrl(b), target: "_blank", rel: "noopener" }, k.url ? "Open on Amazon ↗" : "Search Amazon ↗"),
        k.checkedAt ? el("span", { class: "muted" }, `checked ${ago(k.checkedAt)}`) : null,
        s !== "checking" ? el("button", { on: { click: () => tell({ type: "check", id: b.id }) } }, "Check again") : null),
      k.evidence ? el("details", { class: "why" },
        el("summary", {}, "What Amazon showed"),
        el("p", {}, `From the ${k.source || "Amazon page"}${k.amazonTitle ? ` for “${k.amazonTitle}”` : ""}: `),
        el("p", { class: "evidence" }, k.evidence)) : null));
}

// ---------- events ----------
document.querySelectorAll(".filters button").forEach((btn) => btn.addEventListener("click", () => {
  filter = btn.dataset.f;
  document.querySelectorAll(".filters button").forEach((b) => b.setAttribute("aria-pressed", b === btn));
  render();
}));
$("q").addEventListener("input", (e) => { query = e.target.value; render(); });
$("refresh").addEventListener("click", () => tell({ type: "refresh", recheckAll: true }));
$("settingsBtn").addEventListener("click", () => {
  const f = $("settings"); f.hidden = !f.hidden;
  $("settingsBtn").setAttribute("aria-expanded", String(!f.hidden));
  $("profile").value = state.settings.profile; $("shelf").value = state.settings.shelf;
});
$("settings").addEventListener("submit", async (e) => {
  e.preventDefault();
  const settings = { profile: $("profile").value.trim() || DEFAULTS.profile, shelf: $("shelf").value.trim() || DEFAULTS.shelf };
  const changed = settings.profile !== state.settings.profile || settings.shelf !== state.settings.shelf;
  await chrome.storage.local.set(changed ? { settings, books: [], kindle: {}, booksFetchedAt: 0, unseen: [] } : { settings });
  $("settings").hidden = true;
  tell({ type: "refresh" });
});
// Re-draw whenever the background saves something.
chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local") return;
  await load();
  render();
});
setInterval(render, 60e3); // keep "checked 5 min ago" current

(async () => {
  await load();
  render();
  tell({ type: "opened" }); // clears the badge; checks anything older than a day
})();

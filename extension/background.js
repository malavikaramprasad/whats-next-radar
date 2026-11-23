// Background: keeps the shelf and Kindle details fresh on its own, whether or not the
// What's Next tab is open. Runs on install, when Chrome starts, and every few hours.

const DEFAULTS = { profile: "https://www.goodreads.com/user/show/176924243-malavika-ramprasad", shelf: "to-read" };
const REFRESH_MINUTES = 360;             // re-read Goodreads every 6 hours
const KINDLE_MAX_AGE = 24 * 3600e3;      // re-check each book on Amazon once a day
const CONCURRENCY = 3;                   // books checked at the same time
const GAP_MS = 700;                      // pause between one worker's requests
const STALE_JOB_MS = 10 * 60e3;          // a "running" job older than this was interrupted

let current = null; // the job running in this service worker, if any

// ---------- scheduling ----------
function schedule() {
  chrome.alarms.create("refresh", { periodInMinutes: REFRESH_MINUTES, delayInMinutes: 1 });
}
chrome.runtime.onInstalled.addListener(() => { schedule(); runJob({ forceShelf: true }); });
chrome.runtime.onStartup.addListener(() => { schedule(); runJob({}); });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === "refresh") runJob({ forceShelf: true }); });

// ---------- toolbar icon ----------
chrome.action.onClicked.addListener(async () => {
  const url = chrome.runtime.getURL("dashboard.html");
  const [tab] = await chrome.tabs.query({ url });
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    await chrome.tabs.create({ url });
  }
});

// ---------- messages from the dashboard ----------
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== "background") return false;
  if (msg.type === "refresh") runJob({ forceShelf: true, forceKindle: !!msg.recheckAll });
  if (msg.type === "check") runJob({ onlyIds: [msg.id], forceKindle: true });
  if (msg.type === "opened") { markSeen(); runJob({}); }
  reply({ ok: true });
  return false;
});

// ---------- offscreen document (fetches and parses pages) ----------
let creating = null;
async function ensureOffscreen() {
  const url = chrome.runtime.getURL("offscreen.html");
  const existing = await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"], documentUrls: [url] });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["DOM_PARSER"],
      justification: "Read the Goodreads shelf widget and Amazon Kindle search pages.",
    }).finally(() => { creating = null; });
  }
  await creating;
}
async function offscreen(op, data) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: "offscreen", op, ...data });
  if (!res) throw new Error("No answer from the page reader");
  return res;
}

// ---------- the job ----------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function runJob(opts) {
  if (current) {
    // A job is already running; remember to do a full pass afterwards if this one asked for more.
    if (opts.forceShelf || opts.forceKindle || opts.onlyIds) current.then(() => runJob(opts));
    return current;
  }
  current = doJob(opts).catch((e) => setJob({ running: false, error: e.message, finishedAt: Date.now() }))
    .finally(() => { current = null; });
  return current;
}

async function setJob(patch) {
  const { job = {} } = await chrome.storage.local.get("job");
  await chrome.storage.local.set({ job: { ...job, ...patch } });
}

async function doJob({ forceShelf = false, forceKindle = false, onlyIds = null }) {
  const saved = await chrome.storage.local.get(["settings", "books", "booksFetchedAt", "kindle", "unseen", "job"]);
  if (saved.job && saved.job.running && Date.now() - (saved.job.startedAt || 0) < STALE_JOB_MS && !onlyIds && !forceShelf) {
    return; // another copy of the worker is mid-job
  }
  const settings = { ...DEFAULTS, ...(saved.settings || {}) };
  let books = saved.books || [];
  const kindle = saved.kindle || {};
  let unseen = new Set(saved.unseen || []);
  await setJob({ running: true, startedAt: Date.now(), done: 0, total: 0, blocked: false, error: "", phase: "shelf" });

  // 1. Goodreads shelf
  if (!onlyIds && (forceShelf || !books.length || Date.now() - (saved.booksFetchedAt || 0) > REFRESH_MINUTES * 60e3)) {
    const res = await offscreen("shelf", { profile: settings.profile, shelf: settings.shelf || "to-read" });
    if (!res.ok) {
      await setJob({ running: false, error: `Goodreads: ${res.error}`, finishedAt: Date.now() });
      return;
    }
    if (!res.books.length) {
      await setJob({ running: false, error: "Goodreads: the shelf came back empty. Is the profile public and the shelf name right?", finishedAt: Date.now() });
      return;
    }
    const before = new Set(books.map((b) => b.id));
    if (books.length) for (const b of res.books) if (!before.has(b.id)) unseen.add(b.id);
    const now = new Set(res.books.map((b) => b.id));
    unseen = new Set([...unseen].filter((id) => now.has(id)));
    for (const id of Object.keys(kindle)) if (!now.has(id)) delete kindle[id]; // book left the shelf
    books = res.books;
    await chrome.storage.local.set({ books, booksFetchedAt: Date.now(), unseen: [...unseen], kindle });
  }

  // 2. Amazon, a few books at a time. New books first.
  const todo = books.filter((b) => {
    if (onlyIds && !onlyIds.includes(b.id)) return false;
    const k = kindle[b.id];
    return forceKindle || !k || k.status === "error" || Date.now() - (k.checkedAt || 0) > KINDLE_MAX_AGE;
  }).sort((a, b) => (unseen.has(b.id) ? 1 : 0) - (unseen.has(a.id) ? 1 : 0));

  await setJob({ phase: "amazon", total: todo.length, done: 0, checking: [] });
  let next = 0, done = 0, blocked = false;
  const checking = new Set();
  const worker = async (n) => {
    await sleep(n * 300); // stagger the start
    while (!blocked && next < todo.length) {
      const b = todo[next++];
      checking.add(b.id);
      await setJob({ checking: [...checking] });
      const res = await offscreen("amazon", { book: b });
      checking.delete(b.id);
      if (res.ok) kindle[b.id] = res.result;
      else if (res.blocked) blocked = true;
      else kindle[b.id] = { status: "error", error: res.error, checkedAt: 0 };
      done++;
      await chrome.storage.local.set({ kindle });
      await setJob({ done, checking: [...checking] });
      if (!blocked && next < todo.length) await sleep(GAP_MS + Math.random() * 500);
    }
  };
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, (_, i) => worker(i)));

  await setJob({ running: false, phase: "", checking: [], blocked, finishedAt: Date.now(),
    error: blocked ? "Amazon asked for a CAPTCHA, so checking stopped." : "" });
  await updateBadge();
}

// ---------- badge: new books since the tab was last opened ----------
async function updateBadge() {
  const { unseen = [], kindle = {} } = await chrome.storage.local.get(["unseen", "kindle"]);
  const freeNew = unseen.filter((id) => kindle[id] && kindle[id].status === "yes").length;
  await chrome.action.setBadgeText({ text: unseen.length ? String(unseen.length) : "" });
  await chrome.action.setBadgeBackgroundColor({ color: freeNew ? "#1d7a46" : "#8a4b2a" });
  await chrome.action.setTitle({
    title: unseen.length
      ? `What's Next: ${unseen.length} new book${unseen.length > 1 ? "s" : ""} on your shelf` + (freeNew ? ` (${freeNew} free on KU)` : "")
      : "What's Next",
  });
}
async function markSeen() {
  // Keep the "New" labels visible in the tab that's opening; clear them next time.
  const { unseen = [] } = await chrome.storage.local.get("unseen");
  await chrome.storage.local.set({ unseen: [], justSeen: unseen });
  await updateBadge();
}

// Does one fetch-and-parse job at a time for the background, and replies with plain data.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || msg.target !== "offscreen") return false;
  (async () => {
    try {
      if (msg.op === "shelf") {
        const uid = await goodreadsUserId(msg.profile);
        if (!uid) throw new Error(`Couldn't find the Goodreads profile “${msg.profile}”. Check Settings.`);
        reply({ ok: true, books: await goodreadsShelf(uid, msg.shelf) });
      } else if (msg.op === "amazon") {
        reply({ ok: true, result: await checkAmazon(msg.book) });
      } else {
        reply({ ok: false, error: `Unknown job ${msg.op}` });
      }
    } catch (e) {
      reply({ ok: false, blocked: e instanceof AmazonBlocked, error: e.message });
    }
  })();
  return true; // reply comes later
});

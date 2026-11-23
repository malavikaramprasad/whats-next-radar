# What's Next — Chrome extension

Shows your Goodreads to-read shelf with each book's Kindle Unlimited status and Kindle price.

## Install (once)

1. Unzip `whats-next-extension.zip`. Keep the folder somewhere permanent (Chrome loads it from there).
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **What's Next**.

## Use

It keeps itself up to date in the background while Chrome is running; you don't need to open it:

- **Goodreads:** re-reads your shelf every 6 hours (and when Chrome starts). New books are
  checked on Amazon straight away, and the toolbar icon shows a number badge for new books
  (green if any are free on Kindle Unlimited).
- **Amazon:** finds each book's Kindle edition once, then reads that book's own page (where Amazon
  shows $0.00 / Read for Free to members). Checks 3 books at a time and keeps each result for 24 hours.
  A book counts as free if Amazon shows it at $0.00 for you (kindle+, Kindle Unlimited or Prime Reading).
  Each card has **What Amazon showed**, the text the result was based on.

Click the **What's Next** icon to see the list, with books free on Kindle Unlimited at the top, then paid, then the rest: **✓ Free to read** (Kindle Unlimited), **Paid** with
the Kindle price, or **Not found on Kindle**. New books are labelled **New**. **Refresh** re-reads
Goodreads and re-checks every book now; **Check again** re-checks one book.

If Amazon shows a CAPTCHA, checking stops and says so. Open Amazon, complete it, then press Refresh.

If your computer is asleep or Chrome is closed, nothing runs; it catches up the next time Chrome starts.

## Privacy

Everything runs in your own Chrome. The extension only talks to goodreads.com and amazon.com,
and stores results in Chrome's local extension storage. A hidden extension page reads the
Goodreads and Amazon pages (Chrome's background workers can't parse HTML themselves). Nothing is sent anywhere else.

## Updating

After changing files in the folder, open `chrome://extensions` and click the reload arrow on
**What's Next**.

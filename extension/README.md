# What's Next — Chrome extension

Shows your Goodreads to-read shelf with each book's Kindle Unlimited status and Kindle price.

## Install (once)

1. Unzip `whats-next-extension.zip`. Keep the folder somewhere permanent (Chrome loads it from there).
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and choose the `extension` folder.
5. Pin it: click the puzzle-piece icon in the toolbar, then the pin next to **What's Next**.

## Use

Click the **What's Next** icon. It opens a tab that:

- reads your Goodreads shelf (public shelf widget; set your profile under **Settings**),
- checks each book in Amazon.com's Kindle store, one every ~2.5 seconds, and shows
  **✓ Free to read** (Kindle Unlimited), **Paid** with the Kindle price, or **Not found on Kindle**,
- remembers results and re-checks each book once a week. **Refresh** re-reads Goodreads now;
  **Check again** re-checks one book.

If Amazon shows a CAPTCHA, checking stops and says so. Open Amazon, complete it, then press Refresh.

## Privacy

Everything runs in your own Chrome. The extension only talks to goodreads.com and amazon.com,
and stores results in Chrome's local extension storage. Nothing is sent anywhere else.

## Updating

After changing files in the folder, open `chrome://extensions` and click the reload arrow on
**What's Next**.

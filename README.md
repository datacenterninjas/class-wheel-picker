# 🎡 Class Wheel Picker + participation credits

A random name wheel for picking students in class, built for two batches of about 70 students each. You can give participation credits to the picked student, and the credits are saved to a Google Sheet.

## Features
- **Batch 1 / Batch 2** switcher (keys `1` / `2`). Each batch keeps its own absent marks, picked list and history.
- **Pick modes:** One name · Multiple names · Random groups · Random order for the whole class
- **No repeats:** picked names leave the wheel until you press *Reset round*. *Undo last pick* puts them back.
- **Absent:** tap a name in the roster to take it off the wheel.
- **Credits:**
  - After a pick, press **+2** (good answer), **+1** (tried) or **0** (no answer). The keyboard shortcuts are `2` / `1` / `0`.
  - Switch the roster to *Tap = give credit* to reward a volunteer.
  - Each name shows its total, and the Credits card ranks the batch.
- **Negative marking:** **−1** / **−2** buttons next to the credit buttons (key `-` gives −1). They work after a spin, from the hands-up queue, and in *Tap = give credit* mode. Negative totals show in red.
- **Hands up by QR** (needs the Sheet connection):
  - Press **✋ Start hands-up** (or `H`). A QR and a 4-letter code appear beside the wheel, and stay visible in presentation mode.
  - Students scan it on their phone and type part of their name or their roll number. If several names match, they tap theirs.
  - Raised hands queue in order. Press **Pick next** (or `N`) to get the credit buttons for the first student. ✔ picks a particular student and ✕ removes one.
  - Students see their place in the queue, and their phone tells them when they're up.
  - Rules: one waiting hand per name and per phone. A new round or *End* clears the queue. Click the QR to show it full screen.
- **Works offline:** credits are saved on the device first and sync to the Sheet when the connection comes back. Resending never double-counts.
- **Undo last credit:** adds a minus row to the Sheet. The Log is never edited.
- **Optional rules** (in *Google Sheet connection*):
  - a maximum number of credits per student per day
  - *favour students with fewer credits*, which picks quiet students more often
- Bulk upload of a CSV, XLSX or TXT file to replace a batch's list. When the Sheet is connected, the new list is written to the Roster tab too.
- History per batch with CSV export, presentation mode (`F`), tick sound, confetti, adjustable spin length.
- Fair picks: the winner is chosen with `crypto.getRandomValues` before the wheel animates.

## Where the data lives
| What | Where |
|---|---|
| Student names | Google Sheet → **Roster** tab (`Batch`, `Name`, optional `Roll`). They are not in this repo. Add roll numbers in column C if students should be able to type them on the hands-up page. |
| Hands-up queue | Google Sheet → **Hands** tab: time, round code, batch, name, phone id, status (waiting / picked / removed / lowered / closed) |
| Every credit | Google Sheet → **Log** tab, one row each: time, batch, name, points, source (wheel / manual / undo), class date |
| Totals | Google Sheet → **Totals** tab (a live QUERY over the Log) |
| Web app URL and key | Only in each browser's localStorage, never in the code |
| Absent and picked marks, pick history | Browser localStorage, as before |

## One-time setup
1. **Create the Sheet.** Make a new Google Sheet (e.g. "Class Credits").
2. **Add the script.** In the Sheet: Extensions → Apps Script. Replace the sample code with [`apps-script/Code.gs`](apps-script/Code.gs) and save.
3. **Run setup.** Choose `setup` in the function dropdown, press **Run** and approve the permissions. Google will warn that the app isn't verified, because it's your own script: Advanced → Go to project. The **Execution log** shows your secret key. Run `showKey` to see it again, or `resetKey` if it ever leaks.
4. **Deploy.** Deploy → New deployment → ⚙ Select type → **Web app**.
   - Execute as: **Me**
   - Who has access: **Anyone**. The key protects it. "Anyone with a Google account" will not work from the wheel.

   Copy the **Web app URL** (it ends in `/exec`).
5. **Add names.** In the Roster tab, column A is the batch title exactly as in `students.js` (`Batch 1`, `Batch 2`), and column B is the student's name. You can import a CSV with File → Import → *Append to current sheet*.
6. **Connect the wheel.** Open the wheel → Credits card → *Google Sheet connection* → paste the URL and key → **Connect**. Do this once on every device you use (laptop, phone).

If you change `Code.gs` later: Deploy → Manage deployments → ✏️ → Version: **New version** → Deploy. The URL stays the same.

## Turning credits into marks
Use the **Totals** tab, or a pivot on the **Log** tab, for example:
`participation mark = credits ÷ highest credits in the batch × weight`.
The Log keeps every entry with a date, so you can filter by month or semester.

## Changing batches
The batch ids and titles are in `students.js`. A title must match column A of the Roster tab.

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` in this folder.

## Keyboard
`Space` spin / close popup (skip credit) · `2` `1` `0` `-` credit after a single pick · `H` start hands-up / show QR big · `N` pick next hand · `1` `2` switch batch · `F` full screen · `R` reset round · `Esc` close popup

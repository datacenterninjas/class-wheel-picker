# 🎡 Class Wheel Picker

A random name wheel for picking students in class: built for two batches of about 70 students each.

## Features
- **Batch 1 / Batch 2** switcher (keys `1` / `2`). Each batch keeps its own absent marks, picked list and history.
- **Pick modes:** One name · Multiple names · Random groups · Random order for the whole class
- **No repeats:** picked names leave the wheel until you press *Reset round*. *Undo last pick* puts them back.
- **Absent:** tap a name in the roster to take it off the wheel.
- **Bulk upload** of a CSV, XLSX or TXT file (uses the `Name` column) to replace a batch's list.
- History per batch, with CSV export.
- Presentation (full-screen) mode (`F`), tick sound, confetti, adjustable spin length.
- Fair picks: the winner is chosen with `crypto.getRandomValues` (unbiased) before the wheel animates.
- Everything is saved in the browser's localStorage. There's no server and nothing is tracked.

## Changing the student lists
Edit `students.js` (one name per entry) and push. Saved absent/picked marks are kept for names that stay the same.

## Run locally
Open `index.html` in a browser, or run `python3 -m http.server` in this folder.

## Keyboard
`Space` spin / close popup · `1` `2` switch batch · `F` full screen · `R` reset round · `Esc` close popup

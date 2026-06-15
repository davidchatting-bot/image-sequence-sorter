# Image Sequence Sorter

A p5.js sketch for sorting dropped-in images into a single ordered sequence
via pairwise comparisons (binary insertion sort), then renaming the
corresponding files on disk to match that order.

Source: https://editor.p5js.org/davidchatting/sketches/6IkZVx0a3

## Usage

Open `index.html` in a browser (or serve the directory with a local
static server). Add images by:

- dropping image files (or a whole folder) onto the page, or
- if installed as a desktop app (see below), selecting image files in your
  OS file manager and choosing "Open with > Image Sequence Sorter"

Then sort with:

- **a** — left group is first
- **d** — right group is first
- **S** — equal / merge groups
- **Shift+A** — the left-hand (already-placed) image doesn't belong in the
  sequence - remove it and keep searching for the candidate among the rest
- **Shift+D** — the right-hand (candidate) image doesn't belong in the
  sequence - drop it and move on, without merging or inserting it
- **Esc** — start over

### Direct rename (Chromium browsers)

In browsers that support the File System Access API (Chrome, Edge, etc.), as
soon as sorting is complete and there's anything to rename, a small pop-up
appears with a "Rename files in folder" button (browsers only allow the
folder picker itself to be opened from a click, not a keypress, so this one
click is needed). Clicking it prompts you to pick the folder the images came
from and grant read/write access, then renames each file in place to match
the sorted order. Files in the picked folder that aren't part of the current
sequence are left untouched, and any sorted files not found there are
reported. If nothing needs renaming, no pop-up appears.

Alongside the renamed files, an `exif.json` is written (or overwritten) in
the same folder, mapping each image's final filename to its EXIF/IPTC/XMP
metadata (caption, photographer, credit, date, camera settings, etc.), as
read from the file when it was first loaded.

In other browsers, sorting still works but there's currently no way to apply
the result - use a Chromium-based browser to rename the files.

The chosen folder is remembered (via IndexedDB) for next time. On future
visits the pop-up offers to rename directly in that remembered folder
(re-prompting for permission if needed, but not for the folder itself), with
a "Choose a different folder" option alongside it.

If the browser reports that the folder's cached state is stale (this can
happen after files have already been renamed once), you'll be prompted to
pick the folder again - choose the same folder to continue.

### Installing as a desktop app

In Chromium browsers you can install this as a desktop app (menu > "Install
Image Sequence Sorter..."). Once installed, image files are registered as a
file type this app handles, so selecting one or more images in your OS file
manager and choosing "Open with > Image Sequence Sorter" launches the app
with those files already loaded, ready to sort.

## Build number

The bottom-right corner of the canvas shows the deployment's build number.
It comes from `version.json`, which the GitHub Actions deploy workflow
(`.github/workflows/deploy.yml`) generates from `github.run_number` on every
push to `master` and publishes alongside the site. When running locally
(no `version.json` present) it shows "dev build".

## Dependencies

Loaded from CDN (jsDelivr), not vendored:

- [p5.js](https://p5js.org/) 1.11.10
- p5.sound addon 1.11.10

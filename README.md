# Image Sequence Sorter

A p5.js sketch for sorting dropped-in images into a single ordered sequence
via pairwise comparisons (binary insertion sort), then generating Unix `mv`
commands to rename the corresponding files on disk in that order.

Source: https://editor.p5js.org/davidchatting/sketches/6IkZVx0a3

## Usage

Open `index.html` in a browser (or serve the directory with a local
static server). Add images by:

- dropping image files (or a whole folder) onto the canvas, or
- using the "Choose Files" input to pick individual images, or
- using the "Choose Folder" input to load every image in a folder

Then sort with:

- **A** — left group is first
- **D** — right group is first
- **S** — equal / merge groups
- **W** — start over

Once sorting is complete, a textarea shows the shell commands to rename
the files with a zero-padded order prefix (e.g. `01-`, `02-`, ...).

### Direct rename (Chromium browsers)

In browsers that support the File System Access API (Chrome, Edge, etc.),
an "Open Folder (enables direct rename)" button is also shown. Use it
instead of the inputs above to grant read/write access to a folder — once
sorting is complete, an "Apply renames to folder" button appears that
renames the files in place (no need to copy/paste shell commands). Only
the top level of the chosen folder is read; sub-folders are ignored.

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

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

## Dependencies

Loaded from CDN (jsDelivr), not vendored:

- [p5.js](https://p5js.org/) 1.11.10
- p5.sound addon 1.11.10

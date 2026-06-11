# Image Sequence Sorter

A p5.js sketch for sorting dropped-in images into ordered sequences via
pairwise comparisons (binary insertion sort), then generating Unix
`mkdir`/`mv` commands to reorganise the corresponding files on disk.

Source: https://editor.p5js.org/davidchatting/sketches/6IkZVx0a3

## Usage

Open `index.html` in a browser (or serve the directory with a local
static server). Drop images onto the canvas to begin.

- **A** — left group is first
- **D** — right group is first
- **S** — equal / merge groups
- **X** — start a new sequence
- **W** — start over

Once all sequences are complete, a textarea shows the shell commands to
move/rename the files into `seqNN/` folders.

## Dependencies

Loaded from CDN (jsDelivr), not vendored:

- [p5.js](https://p5js.org/) 1.11.10
- p5.sound addon 1.11.10

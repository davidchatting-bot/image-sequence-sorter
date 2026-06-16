# Image Sequence Sorter

A p5.js sketch for sorting dropped-in images into a single ordered sequence
via pairwise comparisons (binary insertion sort), then saving that order to
a `sequence.json` file alongside the images.

Source: https://editor.p5js.org/davidchatting/sketches/6IkZVx0a3

## Usage

Open `index.html` in a browser (or serve the directory with a local
static server). Add images by:

- dropping image files (or a whole folder) onto the page, or
- dropping a `sequence.json` file on its own (see "Loading a saved sequence"
  below), or
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
- **Esc** — start over (or exit slideshow if in one)
- **f** — toggle fullscreen
- **Space** — once sorting is complete, enter slideshow: goes fullscreen and steps
  through all images in sequence order with a fade between each; press Space to
  advance, Esc to exit back to the sorted view

### Saving the sequence (Chromium browsers)

In browsers that support the File System Access API (Chrome, Edge, etc.), as
soon as sorting is complete a small pop-up appears with a "Save
sequence.json" button (browsers only allow the folder picker itself to be
opened from a click, not a keypress, so this one click is needed). Clicking
it prompts you to pick the folder the images came from and grant read/write
access, then writes (or overwrites) a `sequence.json` file there.

`sequence.json` contains the sorted order - grouped, so images merged with
**S** stay together - with each image annotated with its EXIF/IPTC/XMP
metadata (caption, photographer, credit, date, camera settings, etc.), as
read from the file when it was first loaded:

```json
{
  "sequence": [
    [{ "name": "img2.jpg", "exif": { "...": "..." } }],
    [
      { "name": "img1.jpg", "exif": { "...": "..." } },
      { "name": "img3.jpg", "exif": { "...": "..." } }
    ],
    [{ "name": "img4.jpg", "exif": { "...": "..." } }]
  ]
}
```

The chosen folder is remembered (via IndexedDB) for next time. On future
visits the pop-up offers to save directly to that remembered folder
(re-prompting for permission if needed, but not for the folder itself), with
a "Choose a different folder" option alongside it.

### Loading a saved sequence

If a dropped folder already contains a `sequence.json`, its images are loaded
directly into that stored order and the final sorted view appears
immediately - no comparisons needed. Any images in the folder that aren't
mentioned in `sequence.json` (added since it was last saved) are sorted in
as usual via comparisons against the restored order, and the save pop-up
then offers to write an updated `sequence.json` including them.

You can also drop a `sequence.json` file on its own (not inside a folder)
onto the page. This clears the current session and shows a pop-up asking you
to pick (or re-use the remembered) folder containing the images it lists,
then loads straight into the final sorted view as above. If the remembered
folder already has granted permission, this happens with no pop-up at all -
the images load straight away.

Loading only ever requests read access to the folder; if you then save, the
save pop-up's button click is what prompts for the extra write access needed
to create/overwrite `sequence.json`.

In other browsers, sorting still works but `sequence.json` can't be read or
saved - use a Chromium-based browser for that.

### Installing as a desktop app

In Chromium browsers you can install this as a desktop app (menu > "Install
Image Sequence Sorter..."). The installed app opens fullscreen with no title
bar (`"display": "fullscreen"` in `manifest.json`, falling back to
`"standalone"` - title bar shown - on platforms that don't support that). The
**f** key toggles fullscreen manually, e.g. on a fallback platform or in a
regular browser tab.

Once installed, image files and `sequence.json` files are registered as file
types this app handles, so:

- selecting one or more images in your OS file manager and choosing "Open
  with > Image Sequence Sorter" launches the app with those files already
  loaded, ready to sort.
- right-clicking a `sequence.json` and choosing "Open with > Image Sequence
  Sorter" launches the app and, after you pick the folder it's in (a file
  handle alone doesn't reveal its containing folder), loads the images it
  lists straight into the final sorted view.

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

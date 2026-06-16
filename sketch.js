// Build/deployment number, written to version.json by the GitHub Actions
// deploy workflow on each push (github.run_number). Falls back to "dev"
// when running locally, where version.json doesn't exist.
let deploymentNumber = null;

let imgObjects = [];

// EXIF/IPTC/XMP metadata for each loaded image, keyed by filename.
let imageExif = {};
// Slideshow exit transform per image, keyed by filename. Persisted in
// sequence.json so transforms survive across sessions. Each entry is
// { dx, dy, scale } where dx/dy are fractions of canvas size and scale
// is an additional zoom fraction (e.g. 0.15 = 15% zoom).
let imageTransforms = {};
let groups = []; // each group is an array of image objects
let sortedGroups = [];
let sortingDone = false;

// Sorting state
let currentGroupIndex = 0;
let lo = 0, hi = -1, mid = -1;
let candidateGroup = null;
let currentComparison = null;

// Set once sorting finishes, gating whether a save prompt is needed: stays
// false if a dropped folder's sequence.json already accounted for every
// loaded image (nothing changed), true otherwise (fresh sort, or new images
// were merged into a previously-saved sequence).
let sequenceDirty = true;

// State for a dropped folder's sequence.json check (see traverseEntry):
// pendingSequenceData holds the parsed file once read (or stays null if none
// was found). addImage() defers grouping new images into `groups` while a
// folder is still being read, if it has a sequence.json, so the stored order
// can be applied to the full set of loaded images at once.
let pendingSequenceData = null;
let directoryReadComplete = false;
let pendingFileOps = 0;

// Slideshow state (space to enter, space to advance, Esc to exit)
let slideshowMode = false;
let slideshowImages = [];  // flat ordered list of imgObj, built from sortedGroups on entry
let slideshowIndex = 0;
let slideshowAlpha = 0;       // 0=fully visible, 255=black overlay
let slideshowState = 'idle';  // 'idle' | 'showing' | 'fading-out' | 'reversing'

// UI Elements
let popup;

// File System Access API (Chromium browsers): lets us read/write sequence.json
const fsAccessSupported = 'showDirectoryPicker' in window;
let dirHandle = null;

// Last folder used for sequence.json, persisted via IndexedDB so future
// sessions don't need to re-pick it from scratch.
let rememberedDirHandle = null;

// Pan state. Stored per-image as a fraction (-1..1) of that image's pan
// range in the CURRENT view, not as a pixel offset - the pan range
// (maxPanOffset) depends on the section width, which differs between the
// comparison view and the final view (and between final views with
// different numbers of groups). A fraction stays meaningful across those
// transitions, whereas a pixel offset could fall outside the new range and
// get permanently clamped/lost, leaving the image stuck.
let panFractions = new Map();
let isDragging = false;
let dragStartX = 0;
let activeImg = null;

function setup() {
  createCanvas(windowWidth, windowHeight);
  textAlign(CENTER, CENTER);
  textSize(20);
  background(220);

  // Drag-and-drop anywhere on the page loads images, including dropped
  // folders. Without preventDefault on dragover/drop, the browser would
  // instead navigate to the dropped file.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', onNativeDrop);

  fetch('version.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data && data.deployment) deploymentNumber = data.deployment; })
    .catch(() => {});

  if (fsAccessSupported) loadRememberedDirHandle();

  // When installed as a PWA and launched via "Open with" on image file(s) or
  // a sequence.json (registered as file handlers in manifest.json), load
  // those in. The launch queue retains unconsumed launches until a consumer
  // is set, so registering here in setup() (after p5's globals exist) is
  // safe.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      for (const fileHandle of launchParams.files || []) {
        const file = await fileHandle.getFile();
        if (file.type.startsWith('image/')) {
          addImage({ file, name: file.name, type: file.type });
        } else if (file.name.toLowerCase().endsWith('.json')) {
          await openSequenceFile(file);
        }
      }
    });
  }
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
}

function handleFileSelect(file) {
  if (!file) return;
  const native = file.file || file;
  const name = file.name || (native && native.name) || 'unnamed';
  const type = file.type || (native && native.type) || '';
  if (type && type.startsWith('image')) {
    addImage({ file: native, name, type });
  } else {
    console.log('Ignored non-image:', name);
  }
}

// Routes a file dropped directly onto the page (not from inside a dropped
// folder, which is handled separately by traverseEntry's directory branch):
// images go to handleFileSelect() as usual, while a dropped sequence.json is
// opened via openSequenceFile() - the same path used for "Open with" launches.
function handleDroppedFile(f) {
  if (!f) return;
  if (f.type && f.type.startsWith('image/')) {
    handleFileSelect({ file: f, name: f.name, type: f.type });
  } else if (f.name && f.name.toLowerCase().endsWith('.json')) {
    openSequenceFile(f);
  }
}

function onNativeDrop(e) {
  e.preventDefault();
  const dt = e.dataTransfer;
  if (!dt) return;

  // Use DataTransferItems (supports dropped folders) when available.
  if (dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      const entry = item.webkitGetAsEntry && item.webkitGetAsEntry();
      if (entry) {
        traverseEntry(entry);
      } else if (item.kind === 'file') {
        handleDroppedFile(item.getAsFile());
      }
    }
    return;
  }

  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      handleDroppedFile(f);
    }
  }
}

// Walk a dropped file or folder (FileSystemEntry API), one level deep only
// (sub-folders inside a dropped folder are not traversed).
function traverseEntry(entry) {
  if (entry.isFile) {
    entry.file(handleDroppedFile);
  } else if (entry.isDirectory) {
    directoryReadComplete = false;
    pendingFileOps = 0;
    pendingSequenceData = null;

    const reader = entry.createReader();
    const readNextBatch = () => {
      reader.readEntries(entries => {
        if (!entries.length) {
          directoryReadComplete = true;
          maybeApplyPendingSequence();
          return;
        }
        for (const e of entries) {
          if (e.isFile) {
            pendingFileOps++;
            e.file(f => {
              if (f.type && f.type.startsWith('image/')) handleFileSelect({ file: f, name: f.name, type: f.type });
              pendingFileOps--;
              maybeApplyPendingSequence();
            });
          }
        }
        readNextBatch(); // readEntries() may not return everything in one call
      });
    };

    // Check for a previously-saved sequence.json before reading image files,
    // so addImage() knows up-front whether to hold off on grouping until all
    // files in this folder have been loaded.
    if (typeof entry.getFile === 'function') {
      entry.getFile('sequence.json', {}, fileEntry => {
        fileEntry.file(blob => {
          blob.text().then(text => {
            try { pendingSequenceData = JSON.parse(text); } catch { /* malformed - ignore */ }
            readNextBatch();
          }).catch(() => readNextBatch());
        }, () => readNextBatch());
      }, () => readNextBatch());
    } else {
      readNextBatch();
    }
  }
}

// Called whenever a file from a dropped folder finishes loading, and once
// the folder listing itself is exhausted. Once both conditions hold, any
// sequence.json found for that folder is applied to the now-complete set of
// loaded images.
function maybeApplyPendingSequence() {
  if (!directoryReadComplete || pendingFileOps > 0) return;
  if (pendingSequenceData) applyPendingSequence(pendingSequenceData);
  pendingSequenceData = null;
}

// Arranges already-loaded images into the order recorded in a folder's
// sequence.json, going straight to the final view if every image is
// accounted for. Any images not mentioned in the stored sequence (added
// since it was saved) are appended as new groups and run through the normal
// sort to find their place.
function applyPendingSequence(data) {
  const byName = new Map(imgObjects.map(obj => [obj.name, obj]));
  const usedNames = new Set();
  const matchedGroups = [];

  for (const groupEntries of (data.sequence || [])) {
    const group = [];
    for (const entry of groupEntries) {
      const obj = byName.get(entry.name);
      if (obj) {
        group.push(obj);
        usedNames.add(entry.name);
        if (!imageExif[entry.name]) imageExif[entry.name] = entry.exif || {};
        // undefined = not yet saved; null = explicitly no transition (last image)
        if (!imageTransforms.hasOwnProperty(entry.name)) {
          imageTransforms[entry.name] = entry.transform || null;
        }
      }
    }
    if (group.length) matchedGroups.push(group);
  }

  const newGroups = imgObjects.filter(obj => !usedNames.has(obj.name)).map(obj => [obj]);

  sortedGroups = matchedGroups;
  groups = [...matchedGroups, ...newGroups];
  currentGroupIndex = matchedGroups.length;
  sequenceDirty = newGroups.length > 0;

  if (currentGroupIndex >= groups.length) {
    finishSorting();
  } else {
    beginBinarySearchForCurrentGroup();
  }
}

// Minimal IndexedDB wrapper for remembering the last folder picked via
// showDirectoryPicker() - FileSystemDirectoryHandle objects are structured-
// clonable and can be stored directly.
const IDB_NAME = 'image-sequence-sorter';
const IDB_STORE = 'handles';

function idbOpen() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readonly');
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbSet(key, value) {
  const db = await idbOpen();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(IDB_STORE, 'readwrite');
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function loadRememberedDirHandle() {
  try {
    rememberedDirHandle = (await idbGet('dirHandle')) || null;
  } catch (err) {
    console.error('Failed to load remembered folder:', err);
  }
}

// Sets dirHandle and persists it as the remembered folder for next time.
function rememberDirHandle(handle) {
  dirHandle = handle;
  rememberedDirHandle = handle;
  idbSet('dirHandle', handle).catch(err => console.error('Failed to save remembered folder:', err));
}

// Writes sequence.json (the sorted order, grouped by "equal" merges, each
// image annotated with its EXIF metadata) to `handle` (or, if none given,
// prompts for a folder). Overwrites any existing sequence.json in that
// folder.
async function saveSequence(handle) {
  if (handle) {
    dirHandle = handle;
  } else {
    try {
      dirHandle = await window.showDirectoryPicker({ mode: 'readwrite', id: 'image-sequence-sorter' });
    } catch (err) {
      return; // user cancelled the picker
    }
  }

  if ((await dirHandle.queryPermission({ mode: 'readwrite' })) !== 'granted') {
    if ((await dirHandle.requestPermission({ mode: 'readwrite' })) !== 'granted') {
      showResultMessage('Read/write permission for that folder was not granted - sequence.json not saved.');
      return;
    }
  }

  rememberDirHandle(dirHandle);

  const flat = sortedGroups.flatMap(g => g);
  const lastImg = flat[flat.length - 1];
  const sequence = sortedGroups.map(group => group.map(obj => {
    const entry = { name: obj.name, exif: imageExif[obj.name] || {} };
    if (obj !== lastImg) entry.transform = imageTransforms[obj.name] || defaultTransform(obj.name);
    return entry;
  }));

  try {
    const fileHandle = await dirHandle.getFileHandle('sequence.json', { create: true });
    const writable = await fileHandle.createWritable();
    await writable.write(JSON.stringify({ sequence }, null, 2));
    await writable.close();
    sequenceDirty = false;
    showResultMessage(`Saved sequence.json (${imgObjects.length} image(s)) to "${dirHandle.name}".`);
  } catch (err) {
    console.error('Failed to write sequence.json:', err);
    showResultMessage('Failed to save sequence.json - see console.');
  }
}

// Shows a dismissible pop-up with a message (e.g. the outcome of
// saveSequence()).
function showResultMessage(msg) {
  if (popup) { popup.remove(); popup = null; }

  popup = createDiv('');
  popup.id('popup');
  popup.html(`<p>${msg}</p>`);

  const btn = createButton('OK');
  btn.parent(popup);
  btn.mousePressed(() => {
    popup.remove();
    popup = null;
  });
}

// Handles a sequence.json opened via "Open with" (file_handlers in
// manifest.json). The file itself doesn't give access to the folder it's
// in, so this clears the current session and prompts the user to pick that
// folder so the images it lists can be loaded.
async function openSequenceFile(file) {
  let data = null;
  try {
    data = JSON.parse(await file.text());
  } catch (err) {
    console.error('Failed to parse', file.name, err);
  }

  if (!data || !Array.isArray(data.sequence)) {
    showResultMessage(`"${file.name}" doesn't look like a sequence.json file.`);
    return;
  }

  startOver();

  // queryPermission() (unlike requestPermission() or the folder picker)
  // doesn't need a click, so if the remembered folder still has granted
  // read access, load straight in with no prompt at all.
  if (rememberedDirHandle && (await rememberedDirHandle.queryPermission({ mode: 'read' })) === 'granted') {
    await loadSequenceFromFolder(rememberedDirHandle, data);
    return;
  }

  showLoadPrompt(data);
}

// Chrome only allows showDirectoryPicker() to be called from a click (a
// keypress here doesn't count), so opening a sequence.json shows a pop-up
// whose button click is what's allowed to open the real folder picker.
function showLoadPrompt(data) {
  if (popup) return;

  const count = (data.sequence || []).reduce((n, g) => n + g.length, 0);

  popup = createDiv('');
  popup.id('popup');

  const closePrompt = () => { popup.remove(); popup = null; };

  const pickAndLoad = async () => {
    let handle;
    try {
      handle = await window.showDirectoryPicker({ mode: 'read', id: 'image-sequence-sorter' });
    } catch (err) {
      return; // user cancelled the picker
    }
    closePrompt();
    loadSequenceFromFolder(handle, data);
  };

  if (rememberedDirHandle) {
    popup.html(`<p>Opened sequence.json (${count} image(s)). Load images from "${rememberedDirHandle.name}"?</p>`);

    const btn = createButton(`Load from "${rememberedDirHandle.name}"`);
    btn.parent(popup);
    btn.mousePressed(() => { closePrompt(); loadSequenceFromFolder(rememberedDirHandle, data); });

    const otherBtn = createButton('Choose a different folder');
    otherBtn.parent(popup);
    otherBtn.mousePressed(pickAndLoad);
  } else {
    popup.html(`<p>Opened sequence.json (${count} image(s)). Choose the folder containing these images.</p>`);

    const btn = createButton('Choose folder');
    btn.parent(popup);
    btn.mousePressed(pickAndLoad);
  }
}

// Loads the images named in a sequence.json's `sequence` from `handle`,
// then arranges them via applyPendingSequence() - going straight to the
// final view, since every loaded image is accounted for in `data.sequence`.
async function loadSequenceFromFolder(handle, data) {
  if ((await handle.queryPermission({ mode: 'read' })) !== 'granted') {
    if ((await handle.requestPermission({ mode: 'read' })) !== 'granted') {
      showResultMessage('Read permission for that folder was not granted.');
      return;
    }
  }

  rememberDirHandle(handle);

  const names = new Set();
  for (const group of data.sequence || []) {
    for (const entry of group) names.add(entry.name);
  }

  let missing = 0;
  pendingSequenceData = data;
  for (const name of names) {
    try {
      const fileHandle = await handle.getFileHandle(name);
      const file = await fileHandle.getFile();
      addImage({ file, name: file.name, type: file.type });
    } catch (err) {
      if (err.name !== 'NotFoundError') console.error(`Error loading ${name}:`, err);
      missing++;
    }
  }

  if (imgObjects.length === 0) {
    pendingSequenceData = null;
    showResultMessage('None of the images in sequence.json were found in that folder.');
    return;
  }

  applyPendingSequence(pendingSequenceData);
  pendingSequenceData = null;

  if (missing) showResultMessage(`${missing} image(s) from sequence.json were not found in that folder.`);
}

function startSorting() {
  if (sortingDone) return;
  if (groups.length === 0) return;

  sortedGroups = [groups[0]];
  currentGroupIndex = 1;
  if (groups.length === 1) {
    finishSorting();
  } else {
    beginBinarySearchForCurrentGroup();
  }
}

function beginBinarySearchForCurrentGroup() {
  candidateGroup = groups[currentGroupIndex];
  lo = 0;
  hi = sortedGroups.length - 1;
  nextComparison();
}

function nextComparison() {
  if (lo > hi) {
    sortedGroups.splice(lo, 0, candidateGroup);
    currentGroupIndex++;
    if (currentGroupIndex >= groups.length) {
      finishSorting();
    } else {
      beginBinarySearchForCurrentGroup();
    }
    return;
  }
  mid = Math.floor((lo + hi) / 2);
  currentComparison = [sortedGroups[mid], candidateGroup];
}

function finishSorting() {
  sortingDone = true;
  currentComparison = null;
  if (fsAccessSupported && sequenceDirty) showSavePrompt();
}

// Chrome only allows showDirectoryPicker() to be called from a click (a
// keypress here doesn't count), so we can't pop it open directly once
// sorting finishes via a key. Instead, show a small pop-up with a single
// button - clicking it is the click that opens the real folder picker.
function showSavePrompt() {
  if (popup) return;

  popup = createDiv('');
  popup.id('popup');

  const closePrompt = () => { popup.remove(); popup = null; };

  if (rememberedDirHandle) {
    popup.html(`<p>Sorting complete. Save sequence.json (${imgObjects.length} image(s)) to "${rememberedDirHandle.name}"?</p>`);

    const btn = createButton(`Save to "${rememberedDirHandle.name}"`);
    btn.parent(popup);
    btn.mousePressed(() => { saveSequence(rememberedDirHandle); closePrompt(); });

    const otherBtn = createButton('Choose a different folder');
    otherBtn.parent(popup);
    otherBtn.mousePressed(() => { saveSequence(null); closePrompt(); });
  } else {
    popup.html(`<p>Sorting complete. Save sequence.json (${imgObjects.length} image(s)) to a folder?</p>`);

    const btn = createButton('Save sequence.json');
    btn.parent(popup);
    btn.mousePressed(() => { saveSequence(null); closePrompt(); });
  }
}

function keyPressed() {
  if (keyCode === ESCAPE) {
    if (slideshowMode) { exitSlideshow(); } else { startOver(); }
    return;
  }
  if (key === 'f' || key === 'F') {
    toggleFullscreen();
    return;
  }
  if (keyCode === 32 || keyCode === RIGHT_ARROW) {
    handleSlideshowSpace();
    return;
  }
  if (keyCode === LEFT_ARROW) {
    handleSlideshowLeft();
    return;
  }
  if (!currentComparison) return;

  if (key === 'a') {
    lo = mid + 1;
    nextComparison();
  } else if (key === 'd') {
    hi = mid - 1;
    nextComparison();
  } else if (key === 'S' || key === 's') {
    mergeGroups();
    advanceGroupIndex();
  } else if (key === 'A') {
    discardLeft();
  } else if (key === 'D') {
    discardRight();
  }
}

// Toggles the page in and out of the Fullscreen API, which - unlike the
// PWA's "standalone" display mode alone - hides the window's title bar too.
function toggleFullscreen() {
  if (document.fullscreenElement) {
    document.exitFullscreen();
  } else {
    document.documentElement.requestFullscreen();
  }
}

// Returns a deterministic default exit transform for an image, derived from
// its filename so the same image always gets the same transform, even before
// a sequence.json has been saved. dx/dy are canvas fractions, scale is the
// additional zoom fraction at full fade (e.g. 0.15 = 15% zoom).
function defaultTransform(name) {
  let h = 0;
  for (const c of name) h = Math.imul(31, h) + c.charCodeAt(0) | 0;
  const angle = (Math.abs(h) % 360) * Math.PI / 180;
  return { dx: Math.cos(angle) * 0.08, dy: Math.sin(angle) * 0.04, scale: 0.15 };
}

// Returns the exit transform for imgObj, or null if no transition should play.
// The last image in the show always gets null regardless of what's stored —
// this ensures old sequence.json files (saved before this rule existed) are
// also handled correctly.
function getSlideTransform(imgObj) {
  if (slideshowImages[slideshowImages.length - 1] === imgObj) return null;
  const stored = imageTransforms[imgObj.name];
  if (stored !== undefined) return stored;
  return defaultTransform(imgObj.name);
}

function handleSlideshowSpace() {
  if (!slideshowMode) {
    if (!sortingDone || sortedGroups.length === 0) return;
    slideshowImages = sortedGroups.flatMap(g => g);
    slideshowIndex = 0;
    slideshowAlpha = 0;
    slideshowState = 'showing';
    slideshowMode = true;
    if (!document.fullscreenElement) document.documentElement.requestFullscreen();
  } else if (slideshowState === 'showing') {
    slideshowState = 'fading-out';
  }
}

function handleSlideshowLeft() {
  if (!slideshowMode || slideshowState !== 'showing') return;
  slideshowIndex = (slideshowIndex - 1 + slideshowImages.length) % slideshowImages.length;
  slideshowAlpha = 128;
  slideshowState = 'reversing';
}

function exitSlideshow() {
  slideshowMode = false;
  slideshowState = 'idle';
  slideshowAlpha = 0;
  if (document.fullscreenElement) document.exitFullscreen();
}

function drawSlideshow() {
  // ~2 alpha units/frame at 60fps ≈ 1s transition; same duration in both directions
  if (slideshowState === 'fading-out') {
    slideshowAlpha = min(128, slideshowAlpha + 2);
    if (slideshowAlpha >= 128) {
      slideshowIndex = (slideshowIndex + 1) % slideshowImages.length;
      slideshowAlpha = 0;
      slideshowState = 'showing';
    }
  } else if (slideshowState === 'reversing') {
    slideshowAlpha = max(0, slideshowAlpha - 2);
    if (slideshowAlpha <= 0) slideshowState = 'showing';
  }

  background(0);
  const imgObj = slideshowImages[slideshowIndex];
  if (imgObj) {
    if (slideshowState === 'showing') {
      displayImageFull(imgObj, 0, width, height, panFractions.get(imgObj) || 0);
    } else {
      const tr = getSlideTransform(imgObj);
      const t = Math.sqrt(slideshowAlpha / 128);
      if (tr) {
        // Transform applied at the same t in both directions: for fading-out t
        // rises 0→1 (rest→peak), for reversing t falls 1→0 (peak→rest).
        push();
        translate(width / 2 + tr.dx * width * t, height / 2 + tr.dy * height * t);
        scale(1 + tr.scale * t);
        translate(-width / 2, -height / 2);
        displayImageFull(imgObj, 0, width, height, panFractions.get(imgObj) || 0);
        pop();
      } else if (slideshowState === 'reversing') {
        displayImageFull(imgObj, 0, width, height, panFractions.get(imgObj) || 0);
      }
      // No transform + fading-out: background(0) already holds black for the delay
      if (slideshowAlpha > 0) {
        push();
        noStroke();
        fill(0, slideshowAlpha);
        rect(0, 0, width, height);
        pop();
      }
    }
  }

  push();
  textAlign(LEFT, BOTTOM);
  textSize(14);
  fill(255, 180);
  noStroke();
  text(`${slideshowIndex + 1} / ${slideshowImages.length}`, 12, height - 12);
  pop();
}

// Shift+A: the left image (already placed in sortedGroups) doesn't belong
// in the sequence - remove it and keep searching for the candidate among
// what remains.
function discardLeft() {
  sortedGroups.splice(mid, 1);
  hi--;
  nextComparison();
}

// Shift+D: the right image (the candidate) doesn't belong in the sequence -
// drop it without merging or inserting, then move on to the next image.
function discardRight() {
  advanceGroupIndex();
}

function mergeGroups() {
  let targetGroup = sortedGroups[mid];
  for (let obj of candidateGroup) targetGroup.push(obj);
}

function advanceGroupIndex() {
  currentGroupIndex++;
  if (currentGroupIndex >= groups.length) {
    finishSorting();
  } else {
    beginBinarySearchForCurrentGroup();
  }
}

function draw() {
  background(220);
  if (slideshowMode) {
    drawSlideshow();
  } else if (sortingDone) {
    text("Sorting complete", width / 2, 30);
    displaySortedGroups();
  } else if (currentComparison) {
    text("Which first? [a=Left, d=Right, S=Merge, A=Discard left, D=Discard right]", width / 2, 30);
    displayGroupsInSections([currentComparison[0], currentComparison[1]]);
  } else {
    text("Drop images to start. Press Esc to reset.", width / 2, height / 2);
  }
  drawVersion();
}

function drawVersion() {
  push();
  textAlign(RIGHT, BOTTOM);
  textSize(12);
  fill(120);
  noStroke();
  text(deploymentNumber ? `build ${deploymentNumber}` : 'dev build', width - 8, height - 8);
  pop();
}

function displayGroupsInSections(groupArray) {
  let sectionWidth = width / groupArray.length;
  for (let i = 0; i < groupArray.length; i++) {
    let group = groupArray[i];
    if (group.length > 0) displayImageFull(group[0], i * sectionWidth, sectionWidth, height, panFractions.get(group[0]) || 0);
  }
}

function displayImageFull(imgObj, xStart, wSection, hCanvas, panFraction = 0) {
  let img = imgObj.img;
  if (!img || !img.width || !img.height) return;
  let aspect = img.width / img.height;
  let drawHeight = hCanvas;
  let drawWidth = drawHeight * aspect;

  // maxOffset is this view's pan range for this image; scaling the -1..1
  // fraction by it keeps offsetX within range without needing a clamp. For
  // a cropped image (drawWidth > wSection) this is how far the crop window
  // can slide; for a letterboxed image (drawWidth < wSection) it's how far
  // the image can slide within its empty margin - either way the image
  // stays within its section.
  let maxOffset = Math.abs(drawWidth - wSection) / 2;
  let offsetX = panFraction * maxOffset;

  if (drawWidth > wSection) {
    let cropWidth = (wSection / drawWidth) * img.width;
    let pxPerScreen = img.width / drawWidth;
    // Subtract so the image content follows the drag direction (dragging
    // right moves the image right, revealing more of its left side) -
    // matching the letterboxed case below, where offsetX is added directly.
    let cropX = (img.width - cropWidth) / 2 - offsetX * pxPerScreen;
    image(img, xStart, 0, wSection, hCanvas, cropX, 0, cropWidth, img.height);
  } else {
    let xOffset = (wSection - drawWidth) / 2 + offsetX;
    image(img, xStart + xOffset, 0, drawWidth, drawHeight);
  }
}

function displaySortedGroups() {
  let sectionWidth = width / sortedGroups.length;
  for (let g = 0; g < sortedGroups.length; g++) {
    if (sortedGroups[g].length > 0) displayImageFull(sortedGroups[g][0], g * sectionWidth, sectionWidth, height, panFractions.get(sortedGroups[g][0]) || 0);
  }
}

function mousePressed() {
  if (slideshowMode) {
    isDragging = true;
    dragStartX = mouseX;
    activeImg = slideshowImages[slideshowIndex] || null;
    return;
  }
  let groupArray = currentComparison ? [currentComparison[0], currentComparison[1]] : (sortingDone ? sortedGroups : null);
  if (!groupArray) return;
  let sectionWidth = width / groupArray.length;
  let index = floor(mouseX / sectionWidth);
  if (index >= 0 && index < groupArray.length && groupArray[index].length > 0) {
    isDragging = true;
    dragStartX = mouseX;
    activeImg = groupArray[index][0];
  }
}

function mouseDragged() {
  if (isDragging && activeImg) {
    let deltaX = mouseX - dragStartX;
    let maxOffset = maxPanOffset(activeImg);
    if (maxOffset > 0) {
      let current = panFractions.get(activeImg) || 0;
      let newFraction = constrain(current + deltaX / maxOffset, -1, 1);
      panFractions.set(activeImg, newFraction);
    }
    dragStartX = mouseX;
  }
}

// Width of one image's section of the canvas in the current view (two
// side-by-side during a comparison, one per sorted group in the final view).
function getSectionWidth() {
  if (slideshowMode) return width;
  if (currentComparison) return width / 2;
  if (sortingDone && sortedGroups.length > 0) return width / sortedGroups.length;
  return width;
}

// How far (in screen pixels) imgObj can be panned left/right: for a cropped
// image, how far the crop window can slide; for a letterboxed image, how
// far it can slide within its empty margin before reaching the section edge.
function maxPanOffset(imgObj) {
  let img = imgObj.img;
  if (!img || !img.width || !img.height) return 0;
  let drawWidth = height * (img.width / img.height);
  let wSection = getSectionWidth();
  return Math.abs(drawWidth - wSection) / 2;
}

function mouseReleased() {
  isDragging = false;
  activeImg = null;
}

function startOver() {
  imgObjects = [];
  imageExif = {};
  imageTransforms = {};
  groups = [];
  sortedGroups = [];
  sortingDone = false;
  currentGroupIndex = 0;
  lo = 0; hi = -1; mid = -1;
  candidateGroup = null;
  currentComparison = null;
  panFractions = new Map();
  dirHandle = null;
  sequenceDirty = true;
  pendingSequenceData = null;
  directoryReadComplete = false;
  pendingFileOps = 0;
  slideshowMode = false;
  slideshowState = 'idle';
  slideshowAlpha = 0;
  slideshowImages = [];
  slideshowIndex = 0;
  if (popup) { popup.remove(); popup = null; }
  background(220);
  text("Drop images to start", width / 2, height / 2);
}

function addImage(file) {
  let f = file.file || file;
  if (!(f instanceof File)) {
    console.error("Not a valid File object:", file);
    return;
  }
  let blobURL = URL.createObjectURL(f);
  let img = loadImage(blobURL, () => URL.revokeObjectURL(blobURL));
  let obj = { img, name: f.name };
  imgObjects.push(obj);

  if (typeof exifr !== 'undefined' && exifr.parse) {
    exifr.parse(f, { tiff: true, exif: true, iptc: true, xmp: true, icc: false, jfif: false, ihdr: false })
      .then(exif => { imageExif[f.name] = JSON.parse(JSON.stringify(exif || {})); })
      .catch(err => console.error('EXIF parse error for', f.name, err));
  }

  // While a dropped folder's sequence.json is still being checked/applied,
  // hold off on grouping/sorting - applyPendingSequence() sets up `groups`
  // for the whole folder at once.
  if (!pendingSequenceData) {
    groups.push([obj]);
    if (groups.length > 1) startSorting();
  }

  console.log("Added image:", f.name);
}

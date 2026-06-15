// Build/deployment number, written to version.json by the GitHub Actions
// deploy workflow on each push (github.run_number). Falls back to "dev"
// when running locally, where version.json doesn't exist.
let deploymentNumber = null;

let imgObjects = [];
let groups = []; // each group is an array of image objects
let sortedGroups = [];
let sortingDone = false;

// Sorting state
let currentGroupIndex = 0;
let lo = 0, hi = -1, mid = -1;
let candidateGroup = null;
let currentComparison = null;

// UI Elements
let controlsPanel, folderInput, restartBtn, renamePrompt;

// File System Access API (Chromium browsers): lets us rename files in place
const fsAccessSupported = 'showDirectoryPicker' in window;
let dirHandle = null;

// Last folder used for renaming, persisted via IndexedDB so future sessions
// don't need to re-pick it from scratch.
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

  // Controls float over the canvas in a fixed overlay panel (see #controls
  // in style.css) so they don't add to the page height / cause scrolling.
  controlsPanel = createDiv('');
  controlsPanel.id('controls');

  restartBtn = createButton('Start Over (Esc)');
  restartBtn.mousePressed(startOver);
  restartBtn.parent(controlsPanel);

  // Folder picker: select a whole folder of images at once
  folderInput = createFileInput(handleFileSelect, true);
  folderInput.elt.setAttribute('webkitdirectory', '');
  folderInput.elt.setAttribute('directory', '');
  folderInput.parent(controlsPanel);

  // Drag-and-drop anywhere on the page (including over the floating
  // #controls panel, which sits on top of the canvas) - also handles
  // dropped folders. Without preventDefault on dragover/drop, the browser
  // would instead navigate to the dropped file.
  window.addEventListener('dragover', e => e.preventDefault());
  window.addEventListener('drop', onNativeDrop);

  fetch('version.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data && data.deployment) deploymentNumber = data.deployment; })
    .catch(() => {});

  if (fsAccessSupported) loadRememberedDirHandle();

  // When installed as a PWA and launched via "Open with" on image file(s)
  // (registered as a file handler in manifest.json), load those files in.
  // The launch queue retains unconsumed launches until a consumer is set,
  // so registering here in setup() (after p5's globals exist) is safe.
  if ('launchQueue' in window) {
    window.launchQueue.setConsumer(async (launchParams) => {
      for (const fileHandle of launchParams.files || []) {
        const file = await fileHandle.getFile();
        if (file.type.startsWith('image/')) addImage({ file, name: file.name, type: file.type });
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
        const f = item.getAsFile();
        if (f && f.type.startsWith('image/')) handleFileSelect({ file: f, name: f.name, type: f.type });
      }
    }
    return;
  }

  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      if (f.type && f.type.startsWith('image/')) handleFileSelect({ file: f, name: f.name, type: f.type });
    }
  }
}

// Walk a dropped file or folder (FileSystemEntry API), one level deep only
// (sub-folders inside a dropped folder are not traversed).
function traverseEntry(entry) {
  if (entry.isFile) {
    entry.file(f => {
      if (f.type && f.type.startsWith('image/')) handleFileSelect({ file: f, name: f.name, type: f.type });
    });
  } else if (entry.isDirectory) {
    const reader = entry.createReader();
    const readNextBatch = () => {
      reader.readEntries(entries => {
        if (!entries.length) return;
        for (const e of entries) {
          if (e.isFile) {
            e.file(f => {
              if (f.type && f.type.startsWith('image/')) handleFileSelect({ file: f, name: f.name, type: f.type });
            });
          }
        }
        readNextBatch(); // readEntries() may not return everything in one call
      });
    };
    readNextBatch();
  }
}

// Strips a leftover temp prefix from a previously-interrupted apply (if
// any, in either the old or current format), then any existing two-digit
// order prefix, and caps the length.
function baseNameFor(name) {
  let base = name
    .replace(/^__tmp_\d+_\d+__/, '')
    .replace(/^__tmp\d+__/, '')
    .replace(/^\d{2}-/, '');
  if (base.length > 100) {
    const extIndex = base.lastIndexOf('.');
    const ext = extIndex >= 0 ? base.slice(extIndex) : '';
    base = base.slice(0, 100 - ext.length) + ext;
  }
  return base;
}

// Works out which sorted files need renaming to match the sorted order
// (i.e. their current name doesn't already have the right "NN-" prefix).
// Final names are de-duplicated up front in case two files would otherwise
// reduce to the same name.
function computeRenames() {
  let renames = [];
  let usedNames = new Set();

  sortedGroups.forEach((group, gIdx) => {
    group.forEach(obj => {
      const base = baseNameFor(obj.name);
      let newName = `${String(gIdx + 1).padStart(2, '0')}-${base}`;

      if (newName !== obj.name) {
        let candidate = newName, n = 2;
        while (usedNames.has(candidate)) {
          const extIndex = newName.lastIndexOf('.');
          const ext = extIndex >= 0 ? newName.slice(extIndex) : '';
          const stem = extIndex >= 0 ? newName.slice(0, extIndex) : newName;
          candidate = `${stem}-${n}${ext}`;
          n++;
        }
        newName = candidate;
        // Short, index-based temp name (comparable in length to the "NN-"
        // prefix being added) built from the already length-capped base,
        // so it can't exceed filesystem name limits.
        renames.push({ obj, newName, tempName: `__tmp${renames.length}__${base}` });
      }
      usedNames.add(newName);
    });
  });

  return renames;
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

// Renames each file in `renames` in place to match the sorted order, in the
// given folder (or, if none given, prompts for one). Done in two passes via
// temporary names so swapped/cyclic renames can't overwrite each other.
async function applyRenames(renames, handle) {
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
      showRenameResult('Read/write permission for that folder was not granted - nothing renamed.');
      return;
    }
  }

  rememberDirHandle(dirHandle);

  // Only rename files that actually exist (by name) in the chosen folder -
  // it may not be the one the dropped images came from.
  let toRename = [];
  let notFound = 0;
  for (const r of renames) {
    try {
      await dirHandle.getFileHandle(r.obj.name);
      toRename.push(r);
    } catch (err) {
      if (err.name !== 'NotFoundError') console.error(`Error checking for ${r.obj.name}:`, err);
      notFound++;
    }
  }

  let renamed = 0;
  let failed = [];

  for (const r of toRename) {
    try {
      await renameWithRetry(r.obj.name, r.tempName);
      r.obj.name = r.tempName;
    } catch (err) {
      if (err.name === 'AbortError') break; // user cancelled the re-pick prompt
      console.error(`Failed to rename ${r.obj.name} to a temporary name:`, err);
      failed.push(r.obj.name);
    }
  }
  for (const r of toRename) {
    if (r.obj.name !== r.tempName) continue; // temp rename above failed
    try {
      await renameWithRetry(r.obj.name, r.newName);
      r.obj.name = r.newName;
      renamed++;
    } catch (err) {
      if (err.name === 'AbortError') break;
      console.error(`Failed to rename ${r.obj.name} to ${r.newName}:`, err);
      failed.push(r.obj.name);
    }
  }

  let msg = `Renamed ${renamed} of ${renames.length} file(s) in the selected folder.`;
  if (notFound) msg += ` ${notFound} not found in that folder - is it the right one?`;
  if (failed.length) msg += ` ${failed.length} failed - see console.`;
  console.log(msg);
  showRenameResult(msg);
}

// Shows a dismissible pop-up with the outcome of applyRenames().
function showRenameResult(msg) {
  if (renamePrompt) { renamePrompt.remove(); renamePrompt = null; }

  renamePrompt = createDiv('');
  renamePrompt.id('renamePrompt');
  renamePrompt.html(`<p>${msg}</p>`);

  const btn = createButton('OK');
  btn.parent(renamePrompt);
  btn.mousePressed(() => {
    renamePrompt.remove();
    renamePrompt = null;
  });
}

// Renames oldName -> newName via dirHandle. Chromium can throw
// InvalidStateError ("state cached ... had changed since it was read from
// disk") once a directory handle has been used for prior renames - if so,
// re-prompt for the same folder to get a fresh handle and retry once.
async function renameWithRetry(oldName, newName) {
  try {
    await renameHandle(dirHandle, oldName, newName);
  } catch (err) {
    if (err.name !== 'InvalidStateError') throw err;
    rememberDirHandle(await window.showDirectoryPicker({ mode: 'readwrite', id: 'image-sequence-sorter' }));
    await renameHandle(dirHandle, oldName, newName);
  }
}

// Renames a file in `dir` from `oldName` to `newName`, fetching a fresh
// handle by name so each step doesn't depend on a handle returned by a
// previous move().
async function renameHandle(dir, oldName, newName) {
  const fileHandle = await dir.getFileHandle(oldName);
  if (typeof fileHandle.move === 'function') {
    await fileHandle.move(newName);
    return;
  }
  // Fallback: copy contents to a new file handle, then remove the old one.
  const file = await fileHandle.getFile();
  const data = await file.arrayBuffer();
  const newHandle = await dir.getFileHandle(newName, { create: true });
  const writable = await newHandle.createWritable();
  await writable.write(data);
  await writable.close();
  await dir.removeEntry(oldName);
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
  if (fsAccessSupported) showRenamePrompt();
}

// Chrome only allows showDirectoryPicker() to be called from a click (a
// keypress here doesn't count), so we can't pop it open directly once
// sorting finishes via a key. Instead, show a small pop-up with a single
// button - clicking it is the click that opens the real folder picker.
function showRenamePrompt() {
  if (renamePrompt) return;

  const renames = computeRenames();
  if (renames.length === 0) return; // nothing to rename, no need to prompt

  renamePrompt = createDiv('');
  renamePrompt.id('renamePrompt');

  const closePrompt = () => { renamePrompt.remove(); renamePrompt = null; };

  if (rememberedDirHandle) {
    renamePrompt.html(`<p>Sorting complete. Rename ${renames.length} file(s) in "${rememberedDirHandle.name}" to match this order?</p>`);

    const btn = createButton(`Rename in "${rememberedDirHandle.name}"`);
    btn.parent(renamePrompt);
    btn.mousePressed(() => { applyRenames(renames, rememberedDirHandle); closePrompt(); });

    const otherBtn = createButton('Choose a different folder');
    otherBtn.parent(renamePrompt);
    otherBtn.mousePressed(() => { applyRenames(renames, null); closePrompt(); });
  } else {
    renamePrompt.html(`<p>Sorting complete. Rename ${renames.length} file(s) to match this order?</p>`);

    const btn = createButton('Rename files in folder');
    btn.parent(renamePrompt);
    btn.mousePressed(() => { applyRenames(renames, null); closePrompt(); });
  }
}

function keyPressed() {
  if (keyCode === ESCAPE) {
    startOver();
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
  if (sortingDone) {
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
  groups = [];
  sortedGroups = [];
  sortingDone = false;
  currentGroupIndex = 0;
  lo = 0; hi = -1; mid = -1;
  candidateGroup = null;
  currentComparison = null;
  panFractions = new Map();
  if (folderInput && folderInput.elt) folderInput.elt.value = '';
  dirHandle = null;
  if (renamePrompt) { renamePrompt.remove(); renamePrompt = null; }
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

  groups.push([obj]);

  if (groups.length > 1) startSorting();
  console.log("Added image:", f.name);
}

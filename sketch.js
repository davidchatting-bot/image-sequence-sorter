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
let fileInput, folderInput, restartBtn, openFolderBtn, applyBtn, mvBox;

// File System Access API (Chromium browsers): lets us rename files in place
const fsAccessSupported = 'showDirectoryPicker' in window;
let dirHandle = null;

// Pan state
let panOffsets = new Map();
let isDragging = false;
let dragStartX = 0;
let activeImg = null;

function setup() {
  createCanvas(windowWidth, windowHeight);
  textAlign(CENTER, CENTER);
  textSize(20);
  background(220);

  fileInput = createFileInput(handleFileSelect, true);
  fileInput.position(10, height + 20);

  // Folder picker: select a whole folder of images at once
  folderInput = createFileInput(handleFileSelect, true);
  folderInput.elt.setAttribute('webkitdirectory', '');
  folderInput.elt.setAttribute('directory', '');
  folderInput.position(10, height + 55);

  // Native drop fallback (also handles dropped folders)
  const elt = document.querySelector('canvas');
  if (elt) {
    elt.addEventListener('dragover', e => e.preventDefault());
    elt.addEventListener('drop', onNativeDrop);
  }

  restartBtn = createButton('Start Over (W)');
  restartBtn.mousePressed(startOver);
  restartBtn.position(10, 10);

  if (fsAccessSupported) {
    openFolderBtn = createButton('Open Folder (enables direct rename)');
    openFolderBtn.mousePressed(openFolder);
    openFolderBtn.position(10, 45);
  }

  mvBox = createElement('textarea', '');
  mvBox.id('mvCommandBox');
  mvBox.size(windowWidth - 20, 100);
  mvBox.position(10, height + 90);

  fetch('version.json', { cache: 'no-store' })
    .then(r => r.ok ? r.json() : null)
    .then(data => { if (data && data.deployment) deploymentNumber = data.deployment; })
    .catch(() => {});
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (restartBtn) restartBtn.position(10, 10);
  if (fileInput) fileInput.position(10, height + 20);
  if (folderInput) folderInput.position(10, height + 55);
  if (mvBox) mvBox.size(windowWidth - 20, 100).position(10, height + 90);
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

// Open a folder with read-write access (Chromium browsers only) so the
// resulting renames can be applied directly to disk. Top level only -
// sub-folders are not traversed.
async function openFolder() {
  try {
    dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
  } catch (err) {
    return; // user cancelled the picker
  }
  for await (const [, handle] of dirHandle.entries()) {
    if (handle.kind !== 'file') continue;
    const file = await handle.getFile();
    if (!file.type.startsWith('image/')) continue;
    addImage({ file, name: file.name, type: file.type, handle });
  }
}

function showApplyButton() {
  if (!dirHandle || applyBtn) return;
  applyBtn = createButton('Apply renames to folder');
  applyBtn.mousePressed(applyRenames);
  applyBtn.position(10, 80);
}

// Strips a leftover temp prefix from a previously-interrupted apply (if
// any), then any existing two-digit order prefix, and caps the length.
function baseNameFor(name) {
  let base = name.replace(/^__tmp_\d+_\d+__/, '').replace(/^\d{2}-/, '');
  if (base.length > 100) {
    const extIndex = base.lastIndexOf('.');
    const ext = extIndex >= 0 ? base.slice(extIndex) : '';
    base = base.slice(0, 100 - ext.length) + ext;
  }
  return base;
}

// Renames every sorted file that has a handle (i.e. came from openFolder()).
// Done in two passes via temporary names so swapped/cyclic renames can't
// overwrite each other. Final names are de-duplicated up front in case two
// files would otherwise reduce to the same name.
async function applyRenames() {
  if (!dirHandle) return;

  let renames = [];
  let usedNames = new Set();

  sortedGroups.forEach((group, gIdx) => {
    group.forEach(obj => {
      if (!obj.handle) return;
      let newName = `${String(gIdx + 1).padStart(2, '0')}-${baseNameFor(obj.name)}`;

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
        renames.push({ obj, newName, tempName: `__tmp_${Date.now()}_${Math.floor(Math.random() * 1e9)}__${obj.name}` });
      }
      usedNames.add(newName);
    });
  });

  let renamed = 0;
  let failed = [];

  for (const r of renames) {
    try {
      await renameHandle(dirHandle, r.obj.name, r.tempName);
      r.obj.name = r.tempName;
    } catch (err) {
      console.error(`Failed to rename ${r.obj.name} to a temporary name:`, err);
      failed.push(r.obj.name);
    }
  }
  for (const r of renames) {
    if (r.obj.name !== r.tempName) continue; // temp rename above failed
    try {
      await renameHandle(dirHandle, r.obj.name, r.newName);
      r.obj.handle = await dirHandle.getFileHandle(r.newName);
      r.obj.name = r.newName;
      renamed++;
    } catch (err) {
      console.error(`Failed to rename ${r.obj.name} to ${r.newName}:`, err);
      failed.push(r.obj.name);
    }
  }

  const msg = failed.length
    ? `Renamed ${renamed} of ${renames.length} file(s). ${failed.length} failed - see console.`
    : `Renamed ${renamed} file(s) directly in the selected folder.`;
  console.log(msg);
  if (mvBox) mvBox.value(msg);
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
  generateUnixCommand();
  showApplyButton();
}

function generateUnixCommand() {
  let cmds = sortedGroups.map((group, gIdx) => {
    return group.map(obj => {
      let newName = `${String(gIdx + 1).padStart(2, '0')}-${baseNameFor(obj.name)}`;
      return `mv "${obj.name}" "${newName}"`;
    }).join(' ; ');
  }).join(' ; ');

  console.log("Unix rename command:", cmds);
  if (mvBox) mvBox.value(cmds);
}

function keyPressed() {
  if (key === 'W' || key === 'w') {
    startOver();
    return;
  }
  if (!currentComparison) return;

  if (key === 'A' || key === 'a') {
    lo = mid + 1;
    nextComparison();
  } else if (key === 'D' || key === 'd') {
    hi = mid - 1;
    nextComparison();
  } else if (key === 'S' || key === 's') {
    mergeGroups();
    advanceGroupIndex();
  }
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
    text("Which first? [A=Left, D=Right, S=Equal/Merge]", width / 2, 30);
    displayGroupsInSections([currentComparison[0], currentComparison[1]]);
  } else {
    text("Drop images to start. Press W to reset.", width / 2, height / 2);
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
    if (group.length > 0) displayImageFull(group[0], i * sectionWidth, sectionWidth, height, panOffsets.get(group[0]) || 0);
  }
}

function displayImageFull(imgObj, xStart, wSection, hCanvas, offsetX = 0) {
  let img = imgObj.img;
  if (!img || !img.width || !img.height) return;
  let aspect = img.width / img.height;
  let drawHeight = hCanvas;
  let drawWidth = drawHeight * aspect;

  if (drawWidth > wSection) {
    let cropWidth = (wSection / drawWidth) * img.width;
    let pxPerScreen = img.width / drawWidth;
    let cropX = (img.width - cropWidth) / 2 + offsetX * pxPerScreen;
    cropX = constrain(cropX, 0, img.width - cropWidth);
    image(img, xStart, 0, wSection, hCanvas, cropX, 0, cropWidth, img.height);
  } else {
    let xOffset = (wSection - drawWidth) / 2 + offsetX;
    image(img, xStart + xOffset, 0, drawWidth, drawHeight);
  }
}

function displaySortedGroups() {
  let sectionWidth = width / sortedGroups.length;
  for (let g = 0; g < sortedGroups.length; g++) {
    if (sortedGroups[g].length > 0) displayImageFull(sortedGroups[g][0], g * sectionWidth, sectionWidth, height, 0);
  }
}

function mousePressed() {
  let groupArray = currentComparison ? [currentComparison[0], currentComparison[1]] : null;
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
    panOffsets.set(activeImg, (panOffsets.get(activeImg) || 0) + deltaX);
    dragStartX = mouseX;
  }
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
  panOffsets = new Map();
  if (fileInput && fileInput.elt) fileInput.elt.value = '';
  if (folderInput && folderInput.elt) folderInput.elt.value = '';
  if (mvBox) mvBox.value('');
  dirHandle = null;
  if (applyBtn) { applyBtn.remove(); applyBtn = null; }
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
  let obj = { img, name: f.name, handle: file.handle || null };
  imgObjects.push(obj);

  groups.push([obj]);

  if (groups.length > 1) startSorting();
  console.log("Added image:", f.name);
}

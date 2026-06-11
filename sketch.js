let images = [];
let imgObjects = [];
let sequences = [[]]; // each sequence is an array of groups, each group is an array of image objects
let currentSequence = 0;
let sortedSequences = [];
let sortingDone = false;

// Sorting state within a sequence
let sortedGroups = [];
let currentGroupIndex = 0;
let lo = 0, hi = -1, mid = -1;
let candidateGroup = null;
let currentComparison = null;
let comparisonCount = 0;

// UI Elements
let fileInput, restartBtn, mvBox;

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

  // Native drop fallback
  const elt = document.querySelector('canvas');
  if (elt) {
    elt.addEventListener('dragover', e => e.preventDefault());
    elt.addEventListener('drop', onNativeDrop);
  }

  restartBtn = createButton('Start Over (W)');
  restartBtn.mousePressed(startOver);
  restartBtn.position(10, 10);

  mvBox = createElement('textarea', '');
  mvBox.id('mvCommandBox');
  mvBox.size(windowWidth - 20, 100);
  mvBox.position(10, height + 60);
}

function windowResized() {
  resizeCanvas(windowWidth, windowHeight);
  if (restartBtn) restartBtn.position(10, 10);
  if (fileInput) fileInput.position(10, height + 20);
  if (mvBox) mvBox.size(windowWidth - 20, 100).position(10, height + 60);
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
  if (dt.files && dt.files.length) {
    for (const f of Array.from(dt.files)) {
      if (f.type && f.type.startsWith('image/')) handleFileSelect({ file: f, name: f.name, type: f.type });
    }
  }
}

function startSortingCurrentSequence() {
  if (sortingDone) return;
  if (!sequences[currentSequence] || sequences[currentSequence].length === 0) return;

  sortedGroups = [sequences[currentSequence][0]];
  currentGroupIndex = 1;
  if (sequences[currentSequence].length === 1) {
    finishCurrentSequence();
  } else {
    beginBinarySearchForCurrentGroup();
  }
}

function beginBinarySearchForCurrentGroup() {
  candidateGroup = sequences[currentSequence][currentGroupIndex];
  lo = 0;
  hi = sortedGroups.length - 1;
  nextComparison();
}

function nextComparison() {
  if (lo > hi) {
    sortedGroups.splice(lo, 0, candidateGroup);
    currentGroupIndex++;
    if (currentGroupIndex >= sequences[currentSequence].length) {
      finishCurrentSequence();
    } else {
      beginBinarySearchForCurrentGroup();
    }
    return;
  }
  mid = Math.floor((lo + hi) / 2);
  currentComparison = [sortedGroups[mid], candidateGroup];
}

function finishCurrentSequence() {
  sortedSequences[currentSequence] = sortedGroups.slice();
  currentComparison = null;
  console.log(`Finished sequence ${currentSequence + 1}`);
}

function finishAll() {
  sortingDone = true;
  generateUnixCommand();
}

function generateUnixCommand() {
  let cmds = sortedSequences.map((seq, sIdx) => {
    let folder = `seq${String(sIdx + 1).padStart(2, '0')}`;
    let header = `mkdir -p "${folder}"`;
    let moves = seq.map((group, gIdx) => {
      return group.map(obj => {
        let base = obj.name.replace(/^\d{2}-/, '');
        if (base.length > 100) {
          const extIndex = base.lastIndexOf('.');
          const ext = extIndex >= 0 ? base.slice(extIndex) : '';
          base = base.slice(0, 100 - ext.length) + ext;
        }
        let newName = `${String(gIdx + 1).padStart(2, '0')}-${base}`;
        return `mv "${obj.name}" "${folder}/${newName}"`;
      }).join(' ; ');
    }).join(' ; ');
    return `${header} ; ${moves}`;
  }).join(' ; ');

  console.log("Unix rename/move command:", cmds);
  if (mvBox) mvBox.value(cmds);
}

function keyPressed() {
  if (key === 'W' || key === 'w') {
    startOver();
    return;
  }
  if (key === 'X' || key === 'x') {
    if (sortedGroups.length > 0) sortedSequences[currentSequence] = sortedGroups.slice();
    currentSequence++;
    sequences[currentSequence] = [];
    sortedGroups = [];
    currentGroupIndex = 0;
    currentComparison = null;
    return;
  }
  if (!currentComparison) return;

  if (key === 'A' || key === 'a') {
    comparisonCount++;
    lo = mid + 1;
    nextComparison();
  } else if (key === 'D' || key === 'd') {
    comparisonCount++;
    hi = mid - 1;
    nextComparison();
  } else if (key === 'S' || key === 's') {
    comparisonCount++;
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
  if (currentGroupIndex >= sequences[currentSequence].length) {
    finishCurrentSequence();
  } else {
    beginBinarySearchForCurrentGroup();
  }
}

function draw() {
  background(220);
  if (sortingDone) {
    text("All sequences complete", width / 2, 30);
    displayAllSequences();
    return;
  }

  if (currentComparison) {
    text(`Sequence ${currentSequence + 1}: Which first? [A=Left, D=Right, S=Equal/Merge, X=New Seq]`, width / 2, 30);
    displayGroupsInSections([currentComparison[0], currentComparison[1]]);
  } else {
    text("Drop images to start. Press W to reset, X for new sequence.", width / 2, height / 2);
    if (sequences[currentSequence].length === 0 && currentSequence > 0) finishAll();
  }
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

function displayAllSequences() {
  let rowHeight = height / sortedSequences.length;
  for (let s = 0; s < sortedSequences.length; s++) {
    let seq = sortedSequences[s];
    let sectionWidth = width / seq.length;
    for (let g = 0; g < seq.length; g++) {
      if (seq[g].length > 0) displayImageFull(seq[g][0], g * sectionWidth, sectionWidth, rowHeight, 0);
    }
    fill(0);
    text(`Seq ${s + 1}`, 30, s * rowHeight + 20);
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
  images = [];
  imgObjects = [];
  sequences = [[]];
  currentSequence = 0;
  sortedSequences = [];
  sortedGroups = [];
  sortingDone = false;
  currentGroupIndex = 0;
  lo = 0; hi = -1; mid = -1;
  candidateGroup = null;
  currentComparison = null;
  comparisonCount = 0;
  panOffsets = new Map();
  if (fileInput && fileInput.elt) fileInput.elt.value = '';
  if (mvBox) mvBox.value('');
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

  if (!sequences[currentSequence]) sequences[currentSequence] = [];
  sequences[currentSequence].push([obj]);

  if (imgObjects.length > 1) startSortingCurrentSequence();
  console.log("Added image:", f.name);
}
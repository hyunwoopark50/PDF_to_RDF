(function () {
  'use strict';

  const SKOS_NS = 'http://www.w3.org/2004/02/skos/core#';
  const RDF_NS  = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';

  // --- CodeMirror setup ---
  const editor = CodeMirror.fromTextArea(document.getElementById('turtle-editor'), {
    mode: 'xml',
    theme: 'monokai',
    lineNumbers: true,
    lineWrapping: true,
    autofocus: false,
    tabSize: 2,
    indentWithTabs: false,
  });

  // --- Element refs ---
  const dropZone        = document.getElementById('drop-zone');
  const fileInput       = document.getElementById('pdf-input');
  const fileNameEl      = document.getElementById('file-name');
  const convertBtn      = document.getElementById('convert-btn');
  const statusBar       = document.getElementById('status-bar');
  const uploadSection   = document.getElementById('upload-section');
  const editorBody      = document.getElementById('editor-body');
  const newBtn          = document.getElementById('new-btn');
  const saveBtn         = document.getElementById('save-btn');
  const loadBtn         = document.getElementById('load-btn');
  const downloadBtn     = document.getElementById('download-btn');
  const loadModal       = document.getElementById('load-modal');
  const closeLoadModal  = document.getElementById('close-load-modal');
  const savefileList    = document.getElementById('savefile-list');
  const savefileEmpty   = document.getElementById('savefile-empty');
  const unsavedModal    = document.getElementById('unsaved-modal');
  const unsavedSaveBtn  = document.getElementById('unsaved-save-btn');
  const unsavedDiscardBtn = document.getElementById('unsaved-discard-btn');
  const unsavedCancelBtn  = document.getElementById('unsaved-cancel-btn');

  let selectedFile     = null;
  let currentStem      = 'ontology';
  let currentFilename  = null;    // filename of the currently open file (for overwrite)
  let hasContent       = false;   // true when editor has RDF loaded
  let hasUnsaved       = false;   // true when content changed since last save

  // --- State helpers ---
  function setEditorActive(active) {
    hasContent = active;
    newBtn.disabled      = !active;
    saveBtn.disabled     = !active;
    downloadBtn.disabled = !active;
    if (active) {
      editorBody.classList.remove('hidden');
    }
  }

  function markSaved() {
    hasUnsaved = false;
  }

  function markUnsaved() {
    if (hasContent) hasUnsaved = true;
  }

  // --- Unsaved changes guard ---
  // Returns a Promise: resolves true = proceed, false = cancelled
  function guardUnsaved() {
    if (!hasUnsaved) return Promise.resolve(true);
    return new Promise((resolve) => {
      unsavedModal.classList.remove('hidden');

      function cleanup() {
        unsavedModal.classList.add('hidden');
        unsavedSaveBtn.removeEventListener('click', onSave);
        unsavedDiscardBtn.removeEventListener('click', onDiscard);
        unsavedCancelBtn.removeEventListener('click', onCancel);
      }

      async function onSave() {
        cleanup();
        await doSave();
        resolve(true);
      }
      function onDiscard() { cleanup(); resolve(true); }
      function onCancel()  { cleanup(); resolve(false); }

      unsavedSaveBtn.addEventListener('click', onSave);
      unsavedDiscardBtn.addEventListener('click', onDiscard);
      unsavedCancelBtn.addEventListener('click', onCancel);
    });
  }

  // --- Timestamp helper ---
  function nowStamp() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
  }

  // --- Drop zone ---
  dropZone.addEventListener('click', () => fileInput.click());

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });
  dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  fileInput.addEventListener('change', () => {
    if (fileInput.files[0]) setFile(fileInput.files[0]);
  });

  function setFile(file) {
    if (!file.name.toLowerCase().endsWith('.pdf')) {
      setStatus('error', 'Please select a PDF file.');
      convertBtn.disabled = true;
      fileNameEl.textContent = '';
      selectedFile = null;
      return;
    }
    selectedFile = file;
    fileNameEl.textContent = file.name;
    convertBtn.disabled = false;
    clearStatus();
  }

  // --- Convert ---
  document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedFile) return;

    convertBtn.disabled = true;
    setStatus('loading', 'Extracting text and generating ontology... this may take 1–3 minutes.');

    const formData = new FormData();
    formData.append('pdf_file', selectedFile);

    try {
      const resp = await fetch('/convert', { method: 'POST', body: formData });
      const data = await resp.json();

      if (data.status === 'ok') {
        currentStem = selectedFile.name.replace(/\.pdf$/i, '');
        currentFilename = data.saved_as || null;
        editor.setValue(data.rdf);
        buildConceptPanel(data.rdf);
        setEditorActive(true);
        markSaved();
        setTimeout(() => editor.refresh(), 50);
        const savedMsg = data.saved_as ? ` Saved as: ${data.saved_as}` : '';
        setStatus('success', `Generation complete. Review and edit the result below, then download.${savedMsg}`);
        editorBody.scrollIntoView({ behavior: 'smooth' });
      } else {
        setStatus('error', data.message || 'Generation failed.');
        convertBtn.disabled = false;
      }
    } catch (err) {
      setStatus('error', 'Network error: ' + err.message);
      convertBtn.disabled = false;
    }
  });

  // Track unsaved changes via CodeMirror
  editor.on('change', () => {
    markUnsaved();
    clearTimeout(panelDebounceTimer);
    panelDebounceTimer = setTimeout(() => buildConceptPanel(editor.getValue()), 400);
  });

  // --- New Conversion ---
  newBtn.addEventListener('click', async () => {
    const proceed = await guardUnsaved();
    if (!proceed) return;
    editorBody.classList.add('hidden');
    editor.setValue('');
    fileInput.value = '';
    fileNameEl.textContent = '';
    selectedFile = null;
    convertBtn.disabled = true;
    hasContent = false;
    hasUnsaved = false;
    currentFilename = null;
    newBtn.disabled = saveBtn.disabled = downloadBtn.disabled = true;
    clearStatus();
    clearConceptPanel();
    uploadSection.scrollIntoView({ behavior: 'smooth' });
  });

  // --- Save ---
  async function doSave() {
    const rdf = editor.getValue();
    if (!rdf.trim()) return;
    try {
      const body = { rdf, stem: currentStem };
      if (currentFilename) body.filename = currentFilename;
      const resp = await fetch('/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await resp.json();
      if (data.status === 'ok') {
        currentFilename = data.saved_as;
        markSaved();
        setStatus('success', `Saved: ${data.saved_as}`);
      } else {
        setStatus('error', data.message || 'Save failed.');
      }
    } catch (err) {
      setStatus('error', 'Save error: ' + err.message);
    }
  }

  saveBtn.addEventListener('click', doSave);

  // --- Load ---
  loadBtn.addEventListener('click', async () => {
    const proceed = await guardUnsaved();
    if (!proceed) return;
    await openLoadModal();
  });

  async function openLoadModal() {
    savefileList.innerHTML = '';
    savefileEmpty.classList.add('hidden');
    try {
      const resp = await fetch('/savefiles');
      const data = await resp.json();
      if (data.files && data.files.length > 0) {
        data.files.forEach((filename) => {
          const li = document.createElement('li');
          li.textContent = filename;
          li.addEventListener('click', () => loadFile(filename));
          savefileList.appendChild(li);
        });
      } else {
        savefileEmpty.classList.remove('hidden');
      }
    } catch (err) {
      savefileEmpty.textContent = 'Failed to fetch saved files.';
      savefileEmpty.classList.remove('hidden');
    }
    loadModal.classList.remove('hidden');
  }

  closeLoadModal.addEventListener('click', () => loadModal.classList.add('hidden'));
  loadModal.addEventListener('click', (e) => {
    if (e.target === loadModal) loadModal.classList.add('hidden');
  });

  async function loadFile(filename) {
    loadModal.classList.add('hidden');
    try {
      const resp = await fetch(`/savefiles/${encodeURIComponent(filename)}`);
      const data = await resp.json();
      if (data.status === 'ok') {
        currentStem = filename.replace(/_\d{8}_\d{6}\.rdf$/, '');
        currentFilename = filename;
        editor.setValue(data.rdf);
        buildConceptPanel(data.rdf);
        setEditorActive(true);
        markSaved();
        setTimeout(() => editor.refresh(), 50);
        setStatus('success', `Loaded: ${filename}`);
        editorBody.scrollIntoView({ behavior: 'smooth' });
      } else {
        setStatus('error', data.message || 'Load failed.');
      }
    } catch (err) {
      setStatus('error', 'Load error: ' + err.message);
    }
  }

  // --- Download ---
  downloadBtn.addEventListener('click', () => {
    const rdf = editor.getValue();
    if (!rdf.trim()) return;
    const filename = `${currentStem}_${nowStamp()}.rdf`;
    const blob = new Blob([rdf], { type: 'application/rdf+xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  });

  // --- Concept Panel ---
  const conceptList      = document.getElementById('concept-list');
  const conceptSearch    = document.getElementById('concept-search');
  const labelEditorEl    = document.getElementById('label-editor');
  const editingConceptName = document.getElementById('editing-concept-name');
  const labelTags        = document.getElementById('label-tags');
  const newLabelInput    = document.getElementById('new-label-input');
  const addLabelBtn      = document.getElementById('add-label-btn');
  const closeLabelEditorBtn = document.getElementById('close-label-editor');

  let activeConceptAbout = null;
  let panelDebounceTimer = null;

  conceptSearch.addEventListener('input', () => {
    const q = conceptSearch.value.toLowerCase();
    Array.from(conceptList.querySelectorAll('li')).forEach((li) => {
      li.style.display = li.dataset.label.toLowerCase().includes(q) ? '' : 'none';
    });
  });

  closeLabelEditorBtn.addEventListener('click', () => {
    labelEditorEl.classList.add('hidden');
    activeConceptAbout = null;
    conceptList.querySelectorAll('li.active').forEach((li) => li.classList.remove('active'));
  });

  addLabelBtn.addEventListener('click', () => addLabelFromInput());
  newLabelInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); addLabelFromInput(); }
  });

  function addLabelFromInput() {
    const text = newLabelInput.value.trim();
    if (!text || !activeConceptAbout) return;
    addLabel(activeConceptAbout, text);
    newLabelInput.value = '';
  }

  function buildConceptPanel(rdfString) {
    if (!rdfString.trim()) { clearConceptPanel(); return; }
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(rdfString, 'application/xml');
    if (xmlDoc.querySelector('parsererror')) return;

    // Use namespace-aware query to correctly find skos:Concept elements
    const concepts = xmlDoc.getElementsByTagNameNS(SKOS_NS, 'Concept');
    const previousActive = activeConceptAbout;

    conceptList.innerHTML = '';
    Array.from(concepts).forEach((concept) => {
      const about = concept.getAttributeNS(RDF_NS, 'about') || '';
      const prefLabelEls = concept.getElementsByTagNameNS(SKOS_NS, 'prefLabel');
      const label = prefLabelEls.length > 0 ? prefLabelEls[0].textContent : about.split('#').pop();

      const li = document.createElement('li');
      li.textContent = label;
      li.dataset.label = label;
      li.dataset.about = about;
      if (about === previousActive) li.classList.add('active');
      li.addEventListener('click', () => openLabelEditor(about, label, xmlDoc));
      conceptList.appendChild(li);
    });

    // Re-render label editor if a concept was being edited
    if (previousActive) {
      const concept = findConceptByAbout(xmlDoc, previousActive);
      if (concept) {
        const prefLabelEls = concept.getElementsByTagNameNS(SKOS_NS, 'prefLabel');
        editingConceptName.textContent = prefLabelEls.length > 0 ? prefLabelEls[0].textContent : previousActive.split('#').pop();
        renderLabelTags(previousActive, concept);
        labelEditorEl.classList.remove('hidden');
      }
    }
  }

  function findConceptByAbout(xmlDoc, about) {
    const concepts = xmlDoc.getElementsByTagNameNS(SKOS_NS, 'Concept');
    return Array.from(concepts).find((c) => c.getAttributeNS(RDF_NS, 'about') === about) || null;
  }

  function openLabelEditor(about, label, xmlDoc) {
    activeConceptAbout = about;
    editingConceptName.textContent = label;
    conceptList.querySelectorAll('li').forEach((li) => {
      li.classList.toggle('active', li.dataset.about === about);
    });
    const concept = xmlDoc
      ? findConceptByAbout(xmlDoc, about)
      : findConceptByAbout(parseCurrentXml(), about);
    if (!concept) return;
    renderLabelTags(about, concept);
    labelEditorEl.classList.remove('hidden');
    scrollEditorToConcept(about);
  }

  function scrollEditorToConcept(about) {
    const lines = editor.getValue().split('\n');
    const target = `rdf:about="${about}"`;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(target)) {
        editor.setCursor({ line: i, ch: 0 });
        // Align the line to the top of the editor viewport
        const coords = editor.charCoords({ line: i, ch: 0 }, 'local');
        editor.scrollTo(null, coords.top);
        break;
      }
    }
  }

  function renderLabelTags(about, conceptEl) {
    labelTags.innerHTML = '';
    const altLabels = conceptEl.getElementsByTagNameNS(SKOS_NS, 'altLabel');
    Array.from(altLabels).forEach((al) => {
      const text = al.textContent;
      const tag = document.createElement('div');
      tag.className = 'label-tag';
      tag.innerHTML = `<span>${escapeHtml(text)}</span><button title="Remove">✕</button>`;
      tag.querySelector('button').addEventListener('click', () => removeLabel(about, text));
      labelTags.appendChild(tag);
    });
  }

  function parseCurrentXml() {
    return new DOMParser().parseFromString(editor.getValue(), 'application/xml');
  }

  function addLabel(about, text) {
    const rdf = editor.getValue();
    const escapedAbout = about.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const conceptRegex = new RegExp(
      `(<skos:Concept[^>]*rdf:about="${escapedAbout}"[\\s\\S]*?)(</skos:Concept>)`
    );
    if (!conceptRegex.test(rdf)) return;
    const newRdf = rdf.replace(conceptRegex, (_, body, closing) => {
      return `${body}    <skos:altLabel>${escapeXml(text)}</skos:altLabel>\n  ${closing}`;
    });
    editor.setValue(newRdf);
    const concept = findConceptByAbout(parseCurrentXml(), about);
    if (concept) renderLabelTags(about, concept);
  }

  function removeLabel(about, text) {
    const rdf = editor.getValue();
    const escapedAbout = about.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedText  = escapeXml(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRegex = new RegExp(
      `(rdf:about="${escapedAbout}"[\\s\\S]*?)[ \\t]*<skos:altLabel>${escapedText}</skos:altLabel>\\r?\\n`
    );
    if (!lineRegex.test(rdf)) return;
    const newRdf = rdf.replace(lineRegex, (_, before) => before);
    editor.setValue(newRdf);
    const concept = findConceptByAbout(parseCurrentXml(), about);
    if (concept) renderLabelTags(about, concept);
  }

  function escapeXml(str) {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function escapeHtml(str) {
    const d = document.createElement('div');
    d.appendChild(document.createTextNode(str));
    return d.innerHTML;
  }

  function clearConceptPanel() {
    conceptList.innerHTML = '';
    labelEditorEl.classList.add('hidden');
    activeConceptAbout = null;
  }

  // --- Helpers ---
  function setStatus(type, message) {
    statusBar.className = 'status-bar ' + type;
    statusBar.textContent = message;
  }

  function clearStatus() {
    statusBar.className = 'status-bar hidden';
    statusBar.textContent = '';
  }
})();

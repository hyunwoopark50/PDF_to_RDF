(function () {
  'use strict';

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
  const dropZone = document.getElementById('drop-zone');
  const fileInput = document.getElementById('pdf-input');
  const fileNameEl = document.getElementById('file-name');
  const convertBtn = document.getElementById('convert-btn');
  const statusBar = document.getElementById('status-bar');
  const uploadSection = document.getElementById('upload-section');
  const editorSection = document.getElementById('editor-section');
  const downloadBtn = document.getElementById('download-btn');
  const newBtn = document.getElementById('new-btn');

  // Holds the active file regardless of how it was selected (browse or drag-drop)
  let selectedFile = null;

  // --- Drop zone: click to browse ---
  dropZone.addEventListener('click', () => fileInput.click());

  // --- Drop zone: drag & drop ---
  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('drag-over');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('drag-over');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('drag-over');
    const file = e.dataTransfer.files[0];
    if (file) setFile(file);
  });

  // --- File input change ---
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

  // --- Form submit: convert ---
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
        editor.setValue(data.rdf);
        // Refresh CodeMirror layout after becoming visible
        editorSection.classList.remove('hidden');
        setTimeout(() => editor.refresh(), 50);
        setStatus('success', 'Generation complete. Review and edit the result below, then download.');
        editorSection.scrollIntoView({ behavior: 'smooth' });
      } else {
        setStatus('error', data.message || 'Generation failed.');
        convertBtn.disabled = false;
      }
    } catch (err) {
      setStatus('error', 'Network error: ' + err.message);
      convertBtn.disabled = false;
    }
  });

  // --- Download button ---
  downloadBtn.addEventListener('click', async () => {
    try {
      const resp = await fetch('/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rdf: editor.getValue() }),
      });

      if (!resp.ok) {
        alert('Download failed.');
        return;
      }

      const blob = await resp.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'ontology.rdf';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } catch (err) {
      alert('Download error: ' + err.message);
    }
  });

  // --- New Conversion button ---
  newBtn.addEventListener('click', () => {
    editorSection.classList.add('hidden');
    editor.setValue('');
    fileInput.value = '';
    fileNameEl.textContent = '';
    selectedFile = null;
    convertBtn.disabled = true;
    clearStatus();
    uploadSection.scrollIntoView({ behavior: 'smooth' });
  });

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

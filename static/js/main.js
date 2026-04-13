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
  let isConverting     = false;   // true while GPT conversion is in progress

  const PAGE_TITLE = document.title;

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

  function setConverting(converting) {
    isConverting = converting;
    // 변환 중 모든 주요 버튼 비활성화
    newBtn.disabled      = converting || !hasContent;
    saveBtn.disabled     = converting || !hasContent;
    downloadBtn.disabled = converting || !hasContent;
    loadBtn.disabled     = converting;
    convertBtn.disabled  = converting;
  }

  function markSaved() {
    hasUnsaved = false;
    document.title = PAGE_TITLE;
    saveBtn.classList.remove('btn-unsaved');
  }

  function markUnsaved() {
    if (hasContent && !hasUnsaved) {
      hasUnsaved = true;
      document.title = '* ' + PAGE_TITLE;
      saveBtn.classList.add('btn-unsaved');
    }
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
    const files = Array.from(e.dataTransfer.files).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) setFiles(files);
  });

  fileInput.addEventListener('change', () => {
    const files = Array.from(fileInput.files).filter((f) => f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) setFiles(files);
  });

  let pendingFiles = [];  // 배치 변환 대기 목록

  function setFiles(files) {
    const invalidFiles = files.filter((f) => !f.name.toLowerCase().endsWith('.pdf'));
    if (invalidFiles.length > 0) {
      setStatus('error', 'PDF 파일만 선택할 수 있습니다.');
      return;
    }
    pendingFiles = files;
    selectedFile = files[0];
    if (files.length === 1) {
      fileNameEl.textContent = files[0].name;
    } else {
      fileNameEl.textContent = `${files[0].name} 외 ${files.length - 1}개`;
    }
    convertBtn.disabled = false;
    clearStatus();
  }

  // --- Convert ---
  let currentXhr = null;  // SSE 연결 취소용

  function finishConversion() {
    currentXhr = null;
    setConverting(false);
    convertBtn.textContent = 'Generate Ontology';
    convertBtn.disabled = !selectedFile;
  }

  document.getElementById('upload-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!selectedFile || isConverting) return;

    // 배치 변환: pendingFiles 전체를 순서대로 처리
    const filesToConvert = pendingFiles.length > 0 ? [...pendingFiles] : [selectedFile];
    const total = filesToConvert.length;

    for (let idx = 0; idx < total; idx++) {
      const file = filesToConvert[idx];
      const prefix = total > 1 ? `[${idx + 1}/${total}] ${file.name} — ` : '';

      setConverting(true);
      convertBtn.textContent = 'Cancel';
      convertBtn.disabled = false;
      setStatus('loading', `${prefix}Step 1/3: PDF 텍스트 추출 중...`);

      const formData = new FormData();
      formData.append('pdf_file', file);

      await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        currentXhr = xhr;
        xhr.open('POST', '/convert');
        let lastIndex = 0;
        let lineBuffer = '';  // 여러 onprogress에 걸쳐 분할된 라인 누적
        let resolved = false;

        function handleMsg(msg) {
          if (resolved) return;
          if (msg.type === 'progress') {
            setStatus('loading', `${prefix}${msg.message}`);
          } else if (msg.type === 'done') {
            resolved = true;
            currentStem = file.name.replace(/\.pdf$/i, '');
            currentFilename = msg.saved_as || null;
            editor.setValue(msg.rdf);
            buildConceptPanel(msg.rdf);
            setEditorActive(true);
            markSaved();
            setTimeout(() => editor.refresh(), 50);
            const savedMsg = msg.saved_as ? ` Saved as: ${msg.saved_as}` : '';
            const batchMsg = total > 1 ? ` (${idx + 1}/${total} 완료)` : '';
            setStatus('success', `Generation complete.${batchMsg}${savedMsg}`);
            editorBody.scrollIntoView({ behavior: 'smooth' });
            resolve();
          } else if (msg.type === 'error') {
            resolved = true;
            setStatus('error', `${prefix}${msg.message || 'Generation failed.'}`);
            resolve();
          }
        }

        xhr.onprogress = () => {
          lineBuffer += xhr.responseText.slice(lastIndex);
          lastIndex = xhr.responseText.length;
          // 완전한 라인(\n으로 끝나는)만 처리, 나머지는 버퍼에 보존
          const lines = lineBuffer.split('\n');
          lineBuffer = lines.pop();  // 마지막 불완전 라인은 버퍼에 유지
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try { handleMsg(JSON.parse(line.slice(6))); } catch (_) {}
          }
        };

        xhr.onload = () => {
          // 스트림 종료 시 버퍼에 남은 데이터 처리
          if (lineBuffer.startsWith('data: ')) {
            try { handleMsg(JSON.parse(lineBuffer.slice(6))); } catch (_) {}
          }
          if (!resolved) {
            setStatus('error', `${prefix}Generation failed (no response).`);
            resolve();
          }
        };

        xhr.onerror = () => {
          setStatus('error', `${prefix}Network error. Please try again.`);
          resolve();
        };

        xhr.onabort = () => resolve();
        xhr.send(formData);
      });

      // 취소됐으면 배치 중단
      if (!isConverting && currentXhr === null) break;

      // 마지막 파일이 아니면 다음으로 계속 (짧은 대기)
      if (idx < total - 1) await new Promise((r) => setTimeout(r, 500));
    }

    finishConversion();
  });

  // Cancel 버튼 클릭 시 (변환 중일 때 같은 버튼)
  convertBtn.addEventListener('click', (e) => {
    if (isConverting && currentXhr) {
      e.preventDefault();
      currentXhr.abort();
      currentXhr = null;
      setStatus('error', 'Conversion cancelled.');
      finishConversion();
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
      const resp = await fetch(`/savefiles/load?filename=${encodeURIComponent(filename)}`);
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

    const concepts = xmlDoc.getElementsByTagNameNS(SKOS_NS, 'Concept');
    const previousActive = activeConceptAbout;

    // skos:broader 관계를 기반으로 부모→자식 맵 구성 (계층 트리)
    const broaderMap = {};  // about → parent about
    Array.from(concepts).forEach((concept) => {
      const about = concept.getAttributeNS(RDF_NS, 'about') || '';
      const broaderEls = concept.getElementsByTagNameNS(SKOS_NS, 'broader');
      if (broaderEls.length > 0) {
        broaderMap[about] = broaderEls[0].getAttributeNS(RDF_NS, 'resource') || '';
      }
    });

    // 각 개념의 depth 계산
    function getDepth(about, visited = new Set()) {
      if (!about || !broaderMap[about] || visited.has(about)) return 0;
      visited.add(about);
      return 1 + getDepth(broaderMap[about], visited);
    }

    // grouping node 판별 (skos:narrower 있으면 그룹)
    const groupIRIs = new Set();
    Array.from(concepts).forEach((concept) => {
      if (concept.getElementsByTagNameNS(SKOS_NS, 'narrower').length > 0) {
        groupIRIs.add(concept.getAttributeNS(RDF_NS, 'about') || '');
      }
    });

    conceptList.innerHTML = '';
    Array.from(concepts).forEach((concept) => {
      const about = concept.getAttributeNS(RDF_NS, 'about') || '';
      const prefLabelEls = concept.getElementsByTagNameNS(SKOS_NS, 'prefLabel');
      const label = prefLabelEls.length > 0 ? prefLabelEls[0].textContent : about.split('#').pop();
      const depth = Math.min(getDepth(about), 3);

      const li = document.createElement('li');
      li.textContent = label;
      li.dataset.label = label;
      li.dataset.about = about;
      li.dataset.depth = depth;
      if (depth > 0) li.setAttribute('data-depth', depth);
      if (groupIRIs.has(about)) li.classList.add('is-group');
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

    // RDF 검증 경고 표시 (미정의 IRI 참조)
    showValidationWarnings(xmlDoc);
  }

  function showValidationWarnings(xmlDoc) {
    const existing = document.getElementById('validation-warning-banner');
    if (existing) existing.remove();

    const defined = new Set();
    const referenced = new Set();
    const schemeIRIs = new Set();

    Array.from(xmlDoc.getElementsByTagNameNS(SKOS_NS, 'Concept')).forEach((c) => {
      const about = c.getAttributeNS(RDF_NS, 'about');
      if (about) defined.add(about);
      ['broader', 'narrower', 'related'].forEach((rel) => {
        Array.from(c.getElementsByTagNameNS(SKOS_NS, rel)).forEach((el) => {
          const res = el.getAttributeNS(RDF_NS, 'resource');
          if (res) referenced.add(res);
        });
      });
    });
    Array.from(xmlDoc.getElementsByTagNameNS(SKOS_NS, 'ConceptScheme')).forEach((s) => {
      const about = s.getAttributeNS(RDF_NS, 'about');
      if (about) schemeIRIs.add(about);
    });

    const undefined_iris = [...referenced].filter((iri) => !defined.has(iri) && !schemeIRIs.has(iri));
    if (undefined_iris.length === 0) return;

    const banner = document.createElement('div');
    banner.id = 'validation-warning-banner';
    banner.className = 'validation-warning';
    banner.textContent = `⚠ 미정의 IRI 참조 ${undefined_iris.length}개: ${undefined_iris.slice(0, 3).join(', ')}${undefined_iris.length > 3 ? ' ...' : ''}`;
    const conceptPanel = document.getElementById('concept-panel');
    conceptPanel.insertAdjacentElement('beforebegin', banner);
  }

  function findConceptByAbout(xmlDoc, about) {
    const concepts = xmlDoc.getElementsByTagNameNS(SKOS_NS, 'Concept');
    return Array.from(concepts).find((c) => c.getAttributeNS(RDF_NS, 'about') === about) || null;
  }

  function openLabelEditor(about, label, xmlDoc) {
    activeConceptAbout = about;
    editingConceptName.textContent = label;
    editingConceptName.contentEditable = 'true';
    editingConceptName.title = '클릭하여 prefLabel 편집';

    // prefLabel 인라인 편집: blur 시 XML에 반영
    editingConceptName.onblur = () => {
      const newLabel = editingConceptName.textContent.trim();
      if (!newLabel || newLabel === label) return;
      updatePrefLabel(about, label, newLabel);
      label = newLabel;
    };
    editingConceptName.onkeydown = (e) => {
      if (e.key === 'Enter') { e.preventDefault(); editingConceptName.blur(); }
      if (e.key === 'Escape') { editingConceptName.textContent = label; editingConceptName.blur(); }
    };

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

  function updatePrefLabel(about, oldLabel, newLabel) {
    const rdf = editor.getValue();
    const escapedAbout = about.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedOld = escapeXml(oldLabel).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const regex = new RegExp(
      `(rdf:about="${escapedAbout}"[\\s\\S]*?<skos:prefLabel(?:\\s[^>]*)?>)${escapedOld}(</skos:prefLabel>)`
    );
    if (!regex.test(rdf)) return;
    const scrollInfo = editor.getScrollInfo();
    editor.setValue(rdf.replace(regex, `$1${escapeXml(newLabel)}$2`));
    editor.scrollTo(scrollInfo.left, scrollInfo.top);
    // 개념 목록의 레이블도 업데이트
    conceptList.querySelectorAll('li').forEach((li) => {
      if (li.dataset.about === about) {
        li.textContent = newLabel;
        li.dataset.label = newLabel;
      }
    });
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
      // 들여쓰기 감지: 기존 altLabel 또는 prefLabel에서 추출
      const indentMatch = body.match(/\n([ \t]+)<skos:altLabel/) || body.match(/\n([ \t]+)<skos:prefLabel/);
      const indent = indentMatch ? indentMatch[1] : '    ';
      // 기존 altLabel 뒤에 삽입, 없으면 prefLabel 뒤에 삽입
      const lastAlt = body.lastIndexOf('</skos:altLabel>');
      if (lastAlt !== -1) {
        const pos = lastAlt + '</skos:altLabel>'.length;
        return body.slice(0, pos) + `\n${indent}<skos:altLabel xml:lang="${detectLang(text)}">${escapeXml(text)}</skos:altLabel>` + body.slice(pos) + closing;
      }
      const lastPref = body.lastIndexOf('</skos:prefLabel>');
      if (lastPref !== -1) {
        const pos = lastPref + '</skos:prefLabel>'.length;
        return body.slice(0, pos) + `\n${indent}<skos:altLabel xml:lang="${detectLang(text)}">${escapeXml(text)}</skos:altLabel>` + body.slice(pos) + closing;
      }
      return `${body}${indent}<skos:altLabel xml:lang="${detectLang(text)}">${escapeXml(text)}</skos:altLabel>\n  ${closing}`;
    });
    const scrollInfo = editor.getScrollInfo();
    editor.setValue(newRdf);
    editor.scrollTo(scrollInfo.left, scrollInfo.top);
    const concept = findConceptByAbout(parseCurrentXml(), about);
    if (concept) renderLabelTags(about, concept);
  }

  function removeLabel(about, text) {
    const rdf = editor.getValue();
    const escapedAbout = about.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const escapedText  = escapeXml(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const lineRegex = new RegExp(
      `(rdf:about="${escapedAbout}"[\\s\\S]*?)[ \\t]*<skos:altLabel(?:\\s[^>]*)?>` + escapedText + `</skos:altLabel>\\r?\\n`
    );
    if (!lineRegex.test(rdf)) return;
    const newRdf = rdf.replace(lineRegex, (_, before) => before);
    const scrollInfo = editor.getScrollInfo();
    editor.setValue(newRdf);
    editor.scrollTo(scrollInfo.left, scrollInfo.top);
    const concept = findConceptByAbout(parseCurrentXml(), about);
    if (concept) renderLabelTags(about, concept);
  }

  function detectLang(text) {
    return /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(text) ? 'ko' : 'en';
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

  // --- 키보드 단축키 ---
  document.addEventListener('keydown', async (e) => {
    // ESC: 열린 모달 닫기
    if (e.key === 'Escape') {
      if (!loadModal.classList.contains('hidden')) {
        loadModal.classList.add('hidden');
      } else if (!unsavedModal.classList.contains('hidden')) {
        unsavedModal.classList.add('hidden');
      } else if (!labelEditorEl.classList.contains('hidden')) {
        labelEditorEl.classList.add('hidden');
        activeConceptAbout = null;
        conceptList.querySelectorAll('li.active').forEach((li) => li.classList.remove('active'));
      }
    }

    // Ctrl+S / Cmd+S: 저장
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault();
      if (hasContent && !isConverting) await doSave();
    }

    // Ctrl+Enter / Cmd+Enter: 변환 시작
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
      e.preventDefault();
      if (selectedFile && !isConverting) {
        document.getElementById('upload-form').requestSubmit();
      }
    }
  });

  // --- localStorage 자동 저장 (30초 주기) ---
  const AUTOSAVE_KEY = 'pdf_to_rdf_autosave';

  setInterval(() => {
    if (hasContent && hasUnsaved) {
      const rdf = editor.getValue();
      try {
        localStorage.setItem(AUTOSAVE_KEY, JSON.stringify({
          rdf,
          stem: currentStem,
          filename: currentFilename,
          savedAt: new Date().toISOString(),
        }));
      } catch (_) { /* localStorage 용량 초과 등 무시 */ }
    }
  }, 30000);

  // 페이지 로드 시 자동 저장 복구 확인
  (function checkAutosave() {
    try {
      const raw = localStorage.getItem(AUTOSAVE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw);
      if (!saved.rdf) return;
      const savedAt = new Date(saved.savedAt).toLocaleString();
      const restore = confirm(`자동 저장된 내용이 있습니다. (${savedAt})\n복구하시겠습니까?`);
      if (restore) {
        currentStem = saved.stem || 'ontology';
        currentFilename = saved.filename || null;
        editor.setValue(saved.rdf);
        buildConceptPanel(saved.rdf);
        setEditorActive(true);
        markUnsaved();
        setTimeout(() => editor.refresh(), 50);
        setStatus('success', `자동 저장 복구 완료 (${savedAt})`);
        editorBody.scrollIntoView({ behavior: 'smooth' });
      }
      localStorage.removeItem(AUTOSAVE_KEY);
    } catch (_) { /* 무시 */ }
  })();
})();

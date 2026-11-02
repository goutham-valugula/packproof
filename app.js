(() => {
  'use strict';
  const DB_NAME = 'packproof-local';
  const STORE = 'shipments';
  const $ = (id) => document.getElementById(id);
  const el = {
    list: $('shipmentList'), search: $('searchShipments'), editor: $('editor'), empty: $('emptyState'),
    title: $('editorTitle'), status: $('recordStatus'), savedAt: $('savedAt'), orderRef: $('orderRef'),
    customer: $('customer'), carrier: $('carrier'), date: $('dispatchDate'), notes: $('notes'),
    rows: $('lineRows'), summary: $('checkSummary'), photos: $('photoGrid'), photoInput: $('photoInput'),
    scan: $('scanInput'), cameraPanel: $('cameraPanel'), video: $('cameraVideo'), cameraMessage: $('cameraMessage'), toast: $('toast')
  };
  let db = null;
  let records = [];
  let current = null;
  let saveTimer = null;
  let toastTimer = null;
  let cameraStream = null;
  let detector = null;
  let scanLoop = false;
  let lastScan = { code: '', at: 0 };

  const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(16).slice(2)}`);
  const today = () => { const date = new Date(); return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; };
  const escapeHTML = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
  const dateTime = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) : '—';
  const dateLabel = (value) => value ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(`${value}T12:00:00`)) : 'No dispatch date';

  function openDatabase() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB unavailable'));
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains(STORE)) database.createObjectStore(STORE, { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Could not open local storage'));
    });
  }
  function dbRequest(mode, operation) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = operation(tx.objectStore(STORE));
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('Local save failed'));
      tx.onabort = () => reject(tx.error || new Error('Local save failed'));
    });
  }
  const readFallback = () => JSON.parse(localStorage.getItem(DB_NAME) || '[]');
  const getAllRecords = () => db ? dbRequest('readonly', (store) => store.getAll()) : Promise.resolve(readFallback());
  const persist = (record) => {
    if (db) return dbRequest('readwrite', (store) => store.put(record));
    const all = readFallback();
    const index = all.findIndex((entry) => entry.id === record.id);
    if (index >= 0) all[index] = record; else all.push(record);
    localStorage.setItem(DB_NAME, JSON.stringify(all));
    return Promise.resolve(record);
  };
  const removeRecord = (id) => {
    if (db) return dbRequest('readwrite', (store) => store.delete(id));
    localStorage.setItem(DB_NAME, JSON.stringify(readFallback().filter((entry) => entry.id !== id)));
    return Promise.resolve();
  };

  function notify(message) {
    el.toast.textContent = message;
    el.toast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
  }
  function newRecord() {
    return { id: uid(), orderRef: '', customer: '', carrier: '', dispatchDate: today(), notes: '', lines: [], photos: [], createdAt: Date.now(), updatedAt: Date.now() };
  }
  function showEditor() {
    el.empty.classList.add('hidden');
    el.editor.classList.remove('hidden');
  }
  function showEmpty() {
    current = null;
    el.editor.classList.add('hidden');
    el.empty.classList.remove('hidden');
  }
  async function selectRecord(record) {
    if (current && saveTimer) await flushSave();
    current = structuredClone(record);
    showEditor();
    el.orderRef.value = current.orderRef || '';
    el.customer.value = current.customer || '';
    el.carrier.value = current.carrier || '';
    el.date.value = current.dispatchDate || today();
    el.notes.value = current.notes || '';
    el.title.textContent = current.orderRef ? current.orderRef : 'New shipment';
    el.status.textContent = current.orderRef ? 'SAVED RECORD' : 'DRAFT';
    el.savedAt.textContent = current.updatedAt ? `Last saved ${dateTime(current.updatedAt)}` : 'Not saved';
    renderLines();
    renderPhotos();
    updateSummary();
    renderList();
  }
  function renderList() {
    const query = (el.search.value || '').trim().toLowerCase();
    const filtered = records.filter((record) => [record.orderRef, record.customer, record.carrier].join(' ').toLowerCase().includes(query));
    if (!filtered.length) {
      el.list.innerHTML = `<p class="empty-list">${records.length ? 'No matching orders.' : 'Your packing records will appear here.'}</p>`;
      return;
    }
    el.list.innerHTML = filtered.map((record) => {
      const selected = current?.id === record.id ? ' selected' : '';
      const ref = record.orderRef || 'Untitled shipment';
      return `<div class="shipment-item${selected}" data-id="${escapeHTML(record.id)}" tabindex="0" role="button" aria-label="Open ${escapeHTML(ref)}"><p class="shipment-ref">${escapeHTML(ref)}</p><div class="shipment-meta"><span>${escapeHTML(record.customer || dateLabel(record.dispatchDate))}</span><span>${record.lines?.length || 0} items</span></div></div>`;
    }).join('');
    el.list.querySelectorAll('.shipment-item').forEach((item) => {
      const activate = async () => {
        const found = records.find((record) => record.id === item.dataset.id);
        if (found) await selectRecord(found);
      };
      item.addEventListener('click', () => { void activate(); });
      item.addEventListener('keydown', (event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); void activate(); } });
    });
  }
  function renderLines() {
    if (!current) return;
    if (!current.lines.length) {
      el.rows.innerHTML = '<tr><td colspan="5" class="no-lines">No items yet. Add a line or scan an item barcode.</td></tr>';
      return;
    }
    el.rows.innerHTML = current.lines.map((line) => `<tr data-id="${escapeHTML(line.id)}">
      <td><div class="item-fields"><input data-field="sku" aria-label="SKU or barcode" placeholder="SKU / barcode" value="${escapeHTML(line.sku)}" /><input data-field="name" aria-label="Item description" placeholder="Item description" value="${escapeHTML(line.name)}" /></div></td>
      <td><input class="qty-input" data-field="expected" aria-label="Requested quantity" type="number" min="0" step="1" value="${escapeHTML(line.expected)}" /></td>
      <td><input class="qty-input" data-field="packed" aria-label="Packed quantity" type="number" min="0" step="1" value="${escapeHTML(line.packed)}" /></td>
      <td><input data-field="lot" aria-label="Lot or batch reference" placeholder="Lot / batch" value="${escapeHTML(line.lot)}" /></td>
      <td><button class="remove-line" type="button" aria-label="Remove item">×</button></td></tr>`).join('');
    el.rows.querySelectorAll('input').forEach((input) => {
      input.addEventListener('input', () => {
        const row = input.closest('tr');
        const line = current.lines.find((item) => item.id === row.dataset.id);
        if (!line) return;
        const field = input.dataset.field;
        line[field] = field === 'expected' || field === 'packed' ? Math.max(0, Number(input.value) || 0) : input.value;
        updateSummary();
        scheduleSave();
      });
    });
    el.rows.querySelectorAll('.remove-line').forEach((button) => button.addEventListener('click', () => {
      current.lines = current.lines.filter((line) => line.id !== button.closest('tr').dataset.id);
      renderLines(); updateSummary(); scheduleSave();
    }));
  }
  function updateSummary() {
    if (!current) return;
    const requested = current.lines.reduce((sum, line) => sum + (Number(line.expected) || 0), 0);
    const packed = current.lines.reduce((sum, line) => sum + (Number(line.packed) || 0), 0);
    const mismatches = current.lines.filter((line) => Number(line.expected) !== Number(line.packed)).length;
    const needs = mismatches > 0;
    el.summary.classList.toggle('needs-attention', needs);
    el.summary.innerHTML = `<span><strong>${current.lines.length}</strong> item line${current.lines.length === 1 ? '' : 's'}</span><span><strong>${packed}</strong> packed / ${requested} requested</span><span class="summary-state">${needs ? `${mismatches} line${mismatches === 1 ? '' : 's'} to review` : current.lines.length ? 'Quantities match' : 'Add items to begin'}</span>`;
  }
  function renderPhotos() {
    if (!current) return;
    if (!current.photos?.length) {
      el.photos.innerHTML = '<p class="photo-empty">No photos added. A clear overall shot and close-ups of labels can be useful.</p>';
      return;
    }
    el.photos.innerHTML = current.photos.map((photo) => `<div class="photo-card" data-id="${escapeHTML(photo.id)}"><img src="${photo.data}" alt="Shipment evidence: ${escapeHTML(photo.name)}" /><span title="${escapeHTML(photo.name)}">${escapeHTML(photo.name)}</span><button type="button" aria-label="Remove photo">×</button></div>`).join('');
    el.photos.querySelectorAll('.photo-card button').forEach((button) => button.addEventListener('click', () => {
      current.photos = current.photos.filter((photo) => photo.id !== button.closest('.photo-card').dataset.id);
      renderPhotos(); scheduleSave();
    }));
  }
  function scheduleSave() {
    if (!current) return;
    clearTimeout(saveTimer);
    el.status.textContent = 'SAVING…';
    el.savedAt.textContent = 'Saving changes';
    saveTimer = setTimeout(flushSave, 350);
  }
  async function flushSave() {
    clearTimeout(saveTimer);
    saveTimer = null;
    if (!current) return;
    current.orderRef = el.orderRef.value.trim();
    current.customer = el.customer.value.trim();
    current.carrier = el.carrier.value.trim();
    current.dispatchDate = el.date.value || '';
    current.notes = el.notes.value.trim();
    current.updatedAt = Date.now();
    const snapshot = structuredClone(current);
    try {
      await persist(snapshot);
      const index = records.findIndex((record) => record.id === snapshot.id);
      if (index >= 0) records[index] = snapshot; else records.unshift(snapshot);
      el.title.textContent = snapshot.orderRef || 'New shipment';
      el.status.textContent = snapshot.orderRef ? 'SAVED RECORD' : 'DRAFT';
      el.savedAt.textContent = `Last saved ${dateTime(snapshot.updatedAt)}`;
      renderList();
    } catch (error) {
      console.error(error);
      el.status.textContent = 'SAVE ISSUE';
      el.savedAt.textContent = 'Browser storage unavailable';
      notify('Could not save locally. Export a backup or try another browser.');
    }
  }
  function addLine(values = {}, focusSku = true) {
    if (!current) return;
    current.lines.push({ id: uid(), sku: values.sku || '', name: values.name || '', expected: values.expected ?? '', packed: values.packed ?? '', lot: values.lot || '' });
    renderLines(); updateSummary(); scheduleSave();
    const last = el.rows.querySelector('tr:last-child input[data-field="sku"]');
    if (focusSku) last?.focus();
  }
  function handleScan(code) {
    const cleaned = String(code || '').trim();
    if (!cleaned || !current) return;
    const match = current.lines.find((line) => line.sku.trim().toLowerCase() === cleaned.toLowerCase());
    if (match) {
      match.packed = (Number(match.packed) || 0) + 1;
      renderLines(); updateSummary(); scheduleSave(); notify(`Packed count updated for ${cleaned}`);
    } else {
      addLine({ sku: cleaned, packed: 1 }, false);
      el.scan.focus();
      notify(`Added ${cleaned} with a packed count of 1. Enter requested quantity and lot.`);
    }
  }
  function fileToDataURL(file) {
    return new Promise((resolve, reject) => {
      const source = URL.createObjectURL(file);
      const image = new Image();
      image.onload = () => {
        const scale = Math.min(1, 1800 / Math.max(image.naturalWidth, image.naturalHeight));
        const canvas = document.createElement('canvas');
        canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
        canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
        canvas.getContext('2d', { alpha: false }).drawImage(image, 0, 0, canvas.width, canvas.height);
        URL.revokeObjectURL(source);
        resolve(canvas.toDataURL('image/jpeg', 0.78));
      };
      image.onerror = () => { URL.revokeObjectURL(source); reject(new Error('Could not read this photo')); };
      image.src = source;
    });
  }
  function download(name, type, content) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = name; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function safeFilename(value) { return (value || 'shipment').replace(/[^a-z0-9_-]+/gi, '-').replace(/^-|-$/g, '').slice(0, 60) || 'shipment'; }
  function exportCurrent() {
    if (!current) return;
    flushSave();
    const data = { product: 'PackProof', formatVersion: 1, exportedAt: new Date().toISOString(), record: current };
    download(`packproof-${safeFilename(current.orderRef)}.json`, 'application/json', JSON.stringify(data, null, 2));
    notify('Record backup downloaded. Keep it somewhere private.');
  }
  function exportAll() {
    const data = { product: 'PackProof', formatVersion: 1, exportedAt: new Date().toISOString(), records };
    download('packproof-backup.json', 'application/json', JSON.stringify(data, null, 2));
    notify('Workspace backup downloaded. It may contain customer and shipment details.');
  }
  async function importBackup(file) {
    if (!file) return;
    try {
      const parsed = JSON.parse(await file.text());
      const incoming = Array.isArray(parsed.records) ? parsed.records : parsed.record ? [parsed.record] : [];
      const valid = incoming.filter((record) => record && typeof record.id === 'string' && Array.isArray(record.lines) && record.lines.every((line) => line && typeof line.id === 'string') && Array.isArray(record.photos) && record.photos.length <= 12 && record.photos.every((photo) => photo && typeof photo.id === 'string' && typeof photo.data === 'string' && photo.data.startsWith('data:image/jpeg;base64,')));
      if (!valid.length) throw new Error('No valid PackProof records were found in that file.');
      const known = new Set(records.map((record) => record.id));
      const fresh = valid.filter((record) => !known.has(record.id));
      if (!fresh.length) { notify('These records are already in this browser.'); return; }
      if (!confirm(`Import ${fresh.length} packing record${fresh.length === 1 ? '' : 's'}? They will be added to this browser. Existing records will not be overwritten.`)) return;
      for (const record of fresh) await persist(record);
      records = [...fresh, ...records].sort((a, b) => b.updatedAt - a.updatedAt);
      if (!current && records.length) await selectRecord(records[0]); else renderList();
      notify(`${fresh.length} record${fresh.length === 1 ? '' : 's'} imported.`);
    } catch (error) {
      notify(error.message || 'Could not read that backup file.');
    }
  }
  async function startCamera() {
    if (!current) return;
    if (!navigator.mediaDevices?.getUserMedia || !('BarcodeDetector' in window)) {
      notify('Camera scanning is not available here. Use a USB/Bluetooth scanner or enter the barcode in the scan box.');
      return;
    }
    try {
      detector = new BarcodeDetector({ formats: ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'upc_e', 'qr_code', 'itf'] });
      cameraStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false });
      el.video.srcObject = cameraStream;
      await el.video.play();
      el.cameraPanel.classList.remove('hidden');
      scanLoop = true;
      detectLoop();
    } catch (error) {
      console.error(error);
      stopCamera();
      notify('Camera access failed. Check browser permission or use a scanner.');
    }
  }
  async function detectLoop() {
    if (!scanLoop || !detector || !el.video.videoWidth) { if (scanLoop) requestAnimationFrame(detectLoop); return; }
    try {
      const codes = await detector.detect(el.video);
      const code = codes[0]?.rawValue;
      if (code && (code !== lastScan.code || Date.now() - lastScan.at > 1200)) {
        lastScan = { code, at: Date.now() };
        handleScan(code);
      }
    } catch (error) { /* Continue scanning after a blurry frame. */ }
    if (scanLoop) setTimeout(detectLoop, 260);
  }
  function stopCamera() {
    scanLoop = false;
    if (cameraStream) cameraStream.getTracks().forEach((track) => track.stop());
    cameraStream = null; detector = null;
    el.video.srcObject = null;
    el.cameraPanel.classList.add('hidden');
  }
  async function init() {
    try {
      db = await openDatabase();
      records = await getAllRecords();
    } catch (error) {
      console.warn('IndexedDB unavailable; using browser local storage.', error);
      try { records = readFallback(); }
      catch (fallbackError) { console.warn(fallbackError); notify('Browser storage is unavailable.'); records = []; }
    }
    records.sort((a, b) => b.updatedAt - a.updatedAt);
    renderList();
    if (records.length) await selectRecord(records[0]); else showEmpty();
  }

  $('newShipment').addEventListener('click', async () => { await flushSave(); const record = newRecord(); records.unshift(record); await selectRecord(record); scheduleSave(); el.orderRef.focus(); });
  $('emptyNew').addEventListener('click', () => $('newShipment').click());
  $('addLine').addEventListener('click', () => addLine());
  $('addLineMobile').addEventListener('click', () => addLine());
  $('deleteShipment').addEventListener('click', async () => {
    if (!current || !confirm(`Delete the packing record for “${current.orderRef || 'this shipment'}” from this browser? This cannot be undone.`)) return;
    clearTimeout(saveTimer);
    saveTimer = null;
    const id = current.id;
    stopCamera();
    try { await removeRecord(id); } catch (error) { notify('Could not delete this record from local storage.'); return; }
    records = records.filter((record) => record.id !== id);
    if (records.length) await selectRecord(records[0]); else showEmpty();
    renderList(); notify('Packing record deleted from this browser.');
  });
  $('printReport').addEventListener('click', async () => { await flushSave(); stopCamera(); window.print(); });
  $('saveBackup').addEventListener('click', exportCurrent);
  $('exportBackup').addEventListener('click', exportAll);
  $('importBackup').addEventListener('click', () => $('backupInput').click());
  $('backupInput').addEventListener('change', async () => { await importBackup($('backupInput').files?.[0]); $('backupInput').value = ''; });
  $('cameraScan').addEventListener('click', startCamera);
  $('stopCamera').addEventListener('click', stopCamera);
  $('searchShipments').addEventListener('input', renderList);
  el.scan.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleScan(el.scan.value); el.scan.value = ''; }
  });
  [el.orderRef, el.customer, el.carrier, el.date, el.notes].forEach((input) => input.addEventListener('input', () => {
    if (!current) return;
    if (input === el.orderRef) el.title.textContent = input.value.trim() || 'New shipment';
    scheduleSave();
  }));
  el.photoInput.addEventListener('change', async () => {
    if (!current) return;
    const files = [...el.photoInput.files].slice(0, Math.max(0, 12 - current.photos.length));
    if (!files.length) { notify('A record can hold up to 12 photos.'); el.photoInput.value = ''; return; }
    try {
      for (const file of files) current.photos.push({ id: uid(), name: file.name || `photo-${current.photos.length + 1}.jpg`, data: await fileToDataURL(file), addedAt: Date.now() });
      renderPhotos(); scheduleSave(); notify(`${files.length} photo${files.length === 1 ? '' : 's'} added to this local record.`);
    } catch (error) { notify(error.message); }
    el.photoInput.value = '';
  });
  window.addEventListener('beforeunload', () => { if (saveTimer) flushSave(); stopCamera(); });
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) navigator.serviceWorker.register('./sw.js').catch((error) => console.warn('Offline install unavailable:', error));
  init();
})();

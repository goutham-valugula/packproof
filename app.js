(() => {
  'use strict';
  const DB_NAME = 'packproof-local';
  const STORE = 'shipments';
  const $ = (id) => document.getElementById(id);
  const el = {
    list: $('shipmentList'), search: $('searchShipments'), editor: $('editor'), empty: $('emptyState'),
    title: $('editorTitle'), status: $('recordStatus'), savedAt: $('savedAt'), orderRef: $('orderRef'),
    customer: $('customer'), carrier: $('carrier'), date: $('dispatchDate'), packedBy: $('packedBy'), notes: $('notes'),
    rows: $('lineRows'), summary: $('checkSummary'), photos: $('photoGrid'), photoInput: $('photoInput'),
    scan: $('scanInput'), cameraPanel: $('cameraPanel'), video: $('cameraVideo'), cameraMessage: $('cameraMessage'), toast: $('toast'),
    csvInput: $('csvInput'), dispatchTitle: $('dispatchTitle'), dispatchDetail: $('dispatchDetail'), confirmPack: $('confirmPack')
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
    return { id: uid(), orderRef: '', customer: '', carrier: '', dispatchDate: today(), packedBy: '', notes: '', checkedAt: null, checkedBy: '', lines: [], photos: [], createdAt: Date.now(), updatedAt: Date.now() };
  }
  function normalizeRecord(record) {
    record.packedBy ||= '';
    record.checkedAt ||= null;
    record.checkedBy ||= '';
    record.photos ||= [];
    record.lines = (record.lines || []).map((line) => {
      line.sku ||= '';
      line.name ||= '';
      line.expected ??= '';
      if (!Array.isArray(line.lots)) line.lots = [{ id: uid(), code: line.lot || '', quantity: Number(line.packed) || 0 }];
      line.lots = line.lots.map((lot) => ({ id: lot.id || uid(), code: lot.code || '', quantity: Math.max(0, Number(lot.quantity) || 0) }));
      return line;
    });
    return record;
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
    current = normalizeRecord(structuredClone(record));
    showEditor();
    el.orderRef.value = current.orderRef || '';
    el.customer.value = current.customer || '';
    el.carrier.value = current.carrier || '';
    el.date.value = current.dispatchDate || today();
    el.packedBy.value = current.packedBy || '';
    el.notes.value = current.notes || '';
    el.title.textContent = current.orderRef ? current.orderRef : 'New shipment';
    el.status.textContent = current.checkedAt ? 'PACK CHECKED' : current.orderRef ? 'SAVED RECORD' : 'DRAFT';
    el.savedAt.textContent = current.updatedAt ? `Last saved ${dateTime(current.updatedAt)}` : 'Not saved';
    renderLines();
    renderPhotos();
    updateSummary();
    updateDispatch();
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
      <td><strong class="packed-total">${line.lots.reduce((sum, lot) => sum + lot.quantity, 0)}</strong></td>
      <td><div class="lot-stack">${line.lots.map((lot) => `<div class="lot-row" data-lot-id="${escapeHTML(lot.id)}"><input data-lot-field="code" aria-label="Lot or batch reference" placeholder="Lot / batch" value="${escapeHTML(lot.code)}" /><input class="qty-input" data-lot-field="quantity" aria-label="Quantity from this lot" type="number" min="0" step="1" value="${escapeHTML(lot.quantity)}" /><button class="remove-lot" type="button" aria-label="Remove lot allocation" title="Remove lot">×</button></div>`).join('')}<button class="add-lot" type="button">＋ Add lot</button></div></td>
      <td><button class="remove-line" type="button" aria-label="Remove item">×</button></td></tr>`).join('');
    el.rows.querySelectorAll('input[data-field]').forEach((input) => {
      input.addEventListener('input', () => {
        const row = input.closest('tr');
        const line = current.lines.find((item) => item.id === row.dataset.id);
        if (!line) return;
        const field = input.dataset.field;
        line[field] = field === 'expected' ? Math.max(0, Number(input.value) || 0) : input.value;
        updateSummary();
        updateDispatch();
        scheduleSave();
      });
    });
    el.rows.querySelectorAll('[data-lot-field]').forEach((input) => input.addEventListener('input', () => {
      const row = input.closest('tr');
      const lotRow = input.closest('.lot-row');
      const line = current.lines.find((item) => item.id === row.dataset.id);
      const lot = line?.lots.find((item) => item.id === lotRow.dataset.lotId);
      if (!lot) return;
      lot[input.dataset.lotField] = input.dataset.lotField === 'quantity' ? Math.max(0, Number(input.value) || 0) : input.value.trim();
      row.querySelector('.packed-total').textContent = line.lots.reduce((sum, item) => sum + item.quantity, 0);
      updateSummary(); updateDispatch(); scheduleSave();
    }));
    el.rows.querySelectorAll('.add-lot').forEach((button) => button.addEventListener('click', () => {
      const line = current.lines.find((item) => item.id === button.closest('tr').dataset.id);
      if (!line) return;
      line.lots.push({ id: uid(), code: '', quantity: 0 });
      renderLines(); updateDispatch(); scheduleSave();
      const inputs = el.rows.querySelectorAll('tr:last-child .lot-row:last-of-type input');
      inputs[0]?.focus();
    }));
    el.rows.querySelectorAll('.remove-lot').forEach((button) => button.addEventListener('click', () => {
      const row = button.closest('tr');
      const line = current.lines.find((item) => item.id === row.dataset.id);
      line.lots = line.lots.filter((lot) => lot.id !== button.closest('.lot-row').dataset.lotId);
      renderLines(); updateSummary(); updateDispatch(); scheduleSave();
    }));
    el.rows.querySelectorAll('.remove-line').forEach((button) => button.addEventListener('click', () => {
      current.lines = current.lines.filter((line) => line.id !== button.closest('tr').dataset.id);
      renderLines(); updateSummary(); updateDispatch(); scheduleSave();
    }));
  }
  function updateSummary() {
    if (!current) return;
    const requested = current.lines.reduce((sum, line) => sum + (Number(line.expected) || 0), 0);
    const packed = current.lines.reduce((sum, line) => sum + line.lots.reduce((lotSum, lot) => lotSum + (Number(lot.quantity) || 0), 0), 0);
    const mismatches = current.lines.filter((line) => Number(line.expected) !== line.lots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0)).length;
    const needs = mismatches > 0;
    el.summary.classList.toggle('needs-attention', needs);
    el.summary.innerHTML = `<span><strong>${current.lines.length}</strong> item line${current.lines.length === 1 ? '' : 's'}</span><span><strong>${packed}</strong> packed / ${requested} requested</span><span class="summary-state">${needs ? `${mismatches} line${mismatches === 1 ? '' : 's'} to review` : current.lines.length ? 'Quantities match' : 'Add items to begin'}</span>`;
    updateDispatch();
  }
  function checkIssues() {
    if (!current) return ['Open a packing record first.'];
    const issues = [];
    if (!el.orderRef.value.trim()) issues.push('Add an order reference');
    if (!el.packedBy.value.trim()) issues.push('Enter who packed the order');
    if (!current.lines.length) issues.push('Add at least one item');
    for (const line of current.lines) {
      const packed = line.lots.reduce((sum, lot) => sum + (Number(lot.quantity) || 0), 0);
      if (line.expected === '' || line.expected == null) issues.push(`${line.sku || line.name || 'An item'} is missing requested quantity`);
      if (Number(line.expected) !== packed) issues.push(`${line.sku || line.name || 'An item'} quantity does not match`);
      if (!line.sku.trim() && !line.name.trim()) issues.push('An item line is missing its SKU or description');
      if (line.lots.some((lot) => lot.quantity > 0 && !lot.code.trim())) issues.push(`${line.sku || line.name || 'An item'} has packed quantity without a lot reference`);
    }
    return issues;
  }
  function updateDispatch() {
    if (!current || !el.confirmPack) return;
    const issues = checkIssues();
    const checked = Boolean(current.checkedAt && !issues.length);
    el.dispatchTitle.textContent = checked ? `Pack check confirmed by ${current.checkedBy || current.packedBy}` : issues.length ? 'Finish the pack checks before dispatch' : 'Ready for packer confirmation';
    el.dispatchDetail.textContent = checked ? `Confirmed ${dateTime(current.checkedAt)} on this device.` : issues.length ? issues.slice(0, 3).join(' · ') + (issues.length > 3 ? ` · +${issues.length - 3} more` : '') : 'Quantities match and each packed lot is identified.';
    el.dispatchTitle.closest('.dispatch-check').classList.toggle('confirmed', checked);
    el.confirmPack.textContent = checked ? 'Confirmed ✓' : 'Confirm pack check';
    el.confirmPack.disabled = checked || issues.length > 0;
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
    if (current.checkedAt) { current.checkedAt = null; current.checkedBy = ''; }
    clearTimeout(saveTimer);
    el.status.textContent = 'SAVING…';
    el.savedAt.textContent = 'Saving changes';
    updateDispatch();
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
    current.packedBy = el.packedBy.value.trim();
    current.notes = el.notes.value.trim();
    current.updatedAt = Date.now();
    const snapshot = structuredClone(current);
    try {
      await persist(snapshot);
      const index = records.findIndex((record) => record.id === snapshot.id);
      if (index >= 0) records[index] = snapshot; else records.unshift(snapshot);
      el.title.textContent = snapshot.orderRef || 'New shipment';
      el.status.textContent = snapshot.checkedAt ? 'PACK CHECKED' : snapshot.orderRef ? 'SAVED RECORD' : 'DRAFT';
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
    current.lines.push({ id: uid(), sku: values.sku || '', name: values.name || '', expected: values.expected ?? '', lots: values.lots || [{ id: uid(), code: values.lot || '', quantity: Number(values.packed) || 0 }] });
    renderLines(); updateSummary(); updateDispatch(); scheduleSave();
    const last = el.rows.querySelector('tr:last-child input[data-field="sku"]');
    if (focusSku) last?.focus();
  }
  function handleScan(code) {
    const cleaned = String(code || '').trim();
    if (!cleaned || !current) return;
    const match = current.lines.find((line) => line.sku.trim().toLowerCase() === cleaned.toLowerCase());
    if (match) {
      if (!match.lots.length) match.lots.push({ id: uid(), code: '', quantity: 0 });
      match.lots[0].quantity += 1;
      renderLines(); updateSummary(); updateDispatch(); scheduleSave(); notify(`Packed count updated for ${cleaned}; confirm its lot allocation.`);
    } else {
      addLine({ sku: cleaned, packed: 1 }, false);
      el.scan.focus();
      notify(`Added ${cleaned} with 1 packed. Enter requested quantity and lot.`);
    }
  }
  function parseCSV(text) {
    const rows = [];
    let row = [], cell = '', quoted = false;
    const source = text.replace(/^\uFEFF/, '');
    for (let i = 0; i < source.length; i++) {
      const char = source[i];
      if (quoted && char === '"' && source[i + 1] === '"') { cell += '"'; i++; }
      else if (char === '"') quoted = !quoted;
      else if (char === ',' && !quoted) { row.push(cell.trim()); cell = ''; }
      else if ((char === '\n' || char === '\r') && !quoted) {
        if (char === '\r' && source[i + 1] === '\n') i++;
        row.push(cell.trim());
        if (row.some((value) => value !== '')) rows.push(row);
        row = []; cell = '';
      } else cell += char;
    }
    row.push(cell.trim());
    if (row.some((value) => value !== '')) rows.push(row);
    if (quoted) throw new Error('This CSV has an unclosed quoted field.');
    if (rows.length < 2) throw new Error('The CSV needs a header row and at least one item.');
    const normalize = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
    const headers = rows[0].map(normalize);
    const findColumn = (names) => headers.findIndex((header) => names.includes(header));
    const skuCol = findColumn(['sku', 'barcode', 'itemcode', 'productcode', 'code']);
    const nameCol = findColumn(['name', 'item', 'description', 'product', 'itemdescription']);
    const qtyCol = findColumn(['requested', 'quantity', 'qty', 'ordered', 'orderedqty', 'requestedqty']);
    const lotCol = findColumn(['lot', 'batch', 'lotbatch', 'lotnumber', 'batchnumber']);
    if (qtyCol < 0 || (skuCol < 0 && nameCol < 0)) throw new Error('CSV headers must include SKU or item name, and requested quantity. See the CSV template.');
    const lines = rows.slice(1).map((cells) => {
      const expected = Number((cells[qtyCol] || '').replace(/,/g, ''));
      return { sku: skuCol < 0 ? '' : (cells[skuCol] || ''), name: nameCol < 0 ? '' : (cells[nameCol] || ''), expected, lot: lotCol < 0 ? '' : (cells[lotCol] || '') };
    });
    if (lines.some((line) => !Number.isInteger(line.expected) || line.expected < 0 || (!line.sku && !line.name))) throw new Error('Each CSV row needs an item identifier and a whole-number requested quantity of 0 or more.');
    return lines;
  }
  async function importOrderCSV(file) {
    if (!file || !current) return;
    try {
      const imported = parseCSV(await file.text());
      if (current.lines.length && !confirm(`Append ${imported.length} item lines to this order? Existing lines will be kept.`)) return;
      for (const line of imported) current.lines.push({ id: uid(), sku: line.sku, name: line.name, expected: line.expected, lots: [{ id: uid(), code: line.lot, quantity: 0 }] });
      renderLines(); updateSummary(); scheduleSave();
      notify(`${imported.length} order lines imported. Scan or enter lot allocations as you pack.`);
    } catch (error) { notify(error.message || 'Could not import this CSV.'); }
  }
  function downloadCSVTemplate() {
    download('packproof-order-template.csv', 'text/csv;charset=utf-8', 'sku,name,requested,lot\nSKU-100,Example item,12,\n');
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
  async function exportCurrent() {
    if (!current) return;
    await flushSave();
    const data = { product: 'PackProof', formatVersion: 2, exportedAt: new Date().toISOString(), record: current };
    download(`packproof-${safeFilename(current.orderRef)}.json`, 'application/json', JSON.stringify(data, null, 2));
    notify('Record backup downloaded. Keep it somewhere private.');
  }
  async function exportAll() {
    await flushSave();
    const data = { product: 'PackProof', formatVersion: 2, exportedAt: new Date().toISOString(), records };
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
      const normalized = fresh.map(normalizeRecord);
      for (const record of normalized) await persist(record);
      records = [...normalized, ...records].sort((a, b) => b.updatedAt - a.updatedAt);
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
  $('csvTemplate').addEventListener('click', downloadCSVTemplate);
  el.csvInput.addEventListener('change', async () => { await importOrderCSV(el.csvInput.files?.[0]); el.csvInput.value = ''; });
  el.confirmPack.addEventListener('click', async () => {
    const issues = checkIssues();
    if (issues.length) { notify(issues[0]); updateDispatch(); return; }
    current.checkedAt = Date.now();
    current.checkedBy = el.packedBy.value.trim();
    await flushSave();
    updateDispatch();
    notify('Pack check confirmed on this device.');
  });
  $('searchShipments').addEventListener('input', renderList);
  el.scan.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') { event.preventDefault(); handleScan(el.scan.value); el.scan.value = ''; }
  });
  [el.orderRef, el.customer, el.carrier, el.date, el.packedBy, el.notes].forEach((input) => input.addEventListener('input', () => {
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

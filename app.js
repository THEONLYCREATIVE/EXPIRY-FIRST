/**
 * EXPIRY TRACKER v5.2.0
 * Updated with GTIN-RMS-BARCODE Logic
 * By VYSAKH
 */

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
  DB_NAME: 'ExpiryTrackerDB',
  DB_VERSION: 2,
  EXPIRY_SOON_DAYS: 90,
  VERSION: '5.2.0'
};

// ============================================
// APPLICATION STATE
// ============================================
const App = {
  db: null,
  masterIndex: new Map(), // Maps GTIN and Barcode to the Product Object
  masterRMS: new Map(),   // Maps RMS ID to the Product Object
  settings: {
    apiEnabled: true
  },
  scanner: {
    active: false,
    instance: null,
    cameras: [],
    currentCamera: 0
  },
  filter: 'all',
  search: ''
};

// ============================================
// DATABASE LAYER
// ============================================
const DB = {
  async init() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(CONFIG.DB_NAME, CONFIG.DB_VERSION);
      
      request.onerror = () => reject(request.error);
      
      request.onsuccess = () => {
        App.db = request.result;
        console.log('✅ Database ready');
        resolve();
      };
      
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('gtin', 'gtin', { unique: false });
          historyStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('master')) {
          // Changed keyPath to RMS as it's the unique identity
          const masterStore = db.createObjectStore('master', { keyPath: 'rms' });
          masterStore.createIndex('name', 'name', { unique: false });
          masterStore.createIndex('barcode', 'barcode', { unique: false });
          masterStore.createIndex('gtin', 'gtin', { unique: false });
        }
        
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        
        console.log('📦 Database upgraded');
      };
    });
  },

  async _tx(store, mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction(store, mode);
      const s = tx.objectStore(store);
      const result = fn(s);
      if (result && result.onsuccess !== undefined) {
        result.onsuccess = () => resolve(result.result);
        result.onerror = () => reject(result.error);
      } else {
        tx.oncomplete = () => resolve(result);
        tx.onerror = () => reject(tx.error);
      }
    });
  },

  async addHistory(item) { return this._tx('history', 'readwrite', s => s.add(item)); },
  async updateHistory(item) { return this._tx('history', 'readwrite', s => s.put(item)); },
  async getHistory(id) { return this._tx('history', 'readonly', s => s.get(id)); },
  async getAllHistory() { return this._tx('history', 'readonly', s => s.getAll()); },
  async deleteHistory(id) { return this._tx('history', 'readwrite', s => s.delete(id)); },
  async clearHistory() { return this._tx('history', 'readwrite', s => s.clear()); },

  async addMaster(item) { return this._tx('master', 'readwrite', s => s.put(item)); },
  async getAllMaster() { return this._tx('master', 'readonly', s => s.getAll()); },
  async clearMaster() { return this._tx('master', 'readwrite', s => s.clear()); },

  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      let count = 0;
      for (const item of items) {
        if (item.rms) { // Ensure RMS exists
          store.put(item);
          count++;
        }
      }
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  },

  async getSetting(key, defaultValue = null) {
    try {
      const result = await this._tx('settings', 'readonly', s => s.get(key));
      return result ? result.value : defaultValue;
    } catch { return defaultValue; }
  },
  async setSetting(key, value) { return this._tx('settings', 'readwrite', s => s.put({ key, value })); }
};

// ============================================
// GS1 BARCODE PARSER
// ============================================
const GS1 = {
  parse(code) {
    const result = {
      raw: code || '',
      gtin: '',
      expiry: '',
      expiryISO: '',
      expiryDisplay: '',
      batch: '',
      serial: '',
      qty: 1,
      isGS1: false
    };

    if (!code || typeof code !== 'string') return result;
    code = code.trim().replace(/[\r\n\t]/g, '');

    const hasAI = code.includes('(') || /^01\d{14}/.test(code);

    if (!hasAI) {
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8) {
        result.gtin = digits.padStart(14, '0');
      }
      return result;
    }

    result.isGS1 = true;

    const gtinMatch = code.match(/\(01\)(\d{14})|^01(\d{14})/);
    if (gtinMatch) result.gtin = gtinMatch[1] || gtinMatch[2];

    const expiryMatch = code.match(/\(17\)(\d{6})|17(\d{6})/);
    if (expiryMatch) {
      const yymmdd = expiryMatch[1] || expiryMatch[2];
      result.expiry = yymmdd;
      const yy = parseInt(yymmdd.substring(0, 2));
      const mm = parseInt(yymmdd.substring(2, 4));
      let dd = parseInt(yymmdd.substring(4, 6));
      const year = 2000 + yy;
      if (dd === 0) dd = new Date(year, mm, 0).getDate();
      result.expiryISO = `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
      result.expiryDisplay = `${String(dd).padStart(2, '0')}/${String(mm).padStart(2, '0')}/${year}`;
    }

    const batchMatch = code.match(/\(10\)([^\(]+)|10([A-Za-z0-9\-]+)/);
    if (batchMatch) {
      result.batch = (batchMatch[1] || batchMatch[2] || '').replace(/[^\w\-]/g, '').substring(0, 20);
    }

    const serialMatch = code.match(/\(21\)([^\(]+)|21([A-Za-z0-9]+)/);
    if (serialMatch) {
      result.serial = (serialMatch[1] || serialMatch[2] || '').substring(0, 20);
    }

    return result;
  },

  getExpiryStatus(expiryISO) {
    if (!expiryISO) return 'unknown';
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const expiry = new Date(expiryISO);
    expiry.setHours(0, 0, 0, 0);
    const diffDays = Math.floor((expiry - today) / (1000 * 60 * 60 * 24));
    if (diffDays < 0) return 'expired';
    if (diffDays <= CONFIG.EXPIRY_SOON_DAYS) return 'expiring';
    return 'ok';
  }
};

// ============================================
// PRODUCT MATCHING (UPDATED LOGIC)
// ============================================
const Matcher = {
  buildIndex(masterData) {
    App.masterIndex.clear();
    App.masterRMS.clear();

    for (const item of masterData) {
      const gtinRaw = String(item.gtin || '').replace(/\D/g, '');
      const barcodeRaw = String(item.barcode || '').replace(/\D/g, '');
      const rms = String(item.rms || '').trim();

      // Store by GTIN (14-digit padded)
      if (gtinRaw) {
        const gtin14 = gtinRaw.padStart(14, '0');
        App.masterIndex.set(gtin14, item);
      }

      // Store by Barcode
      if (barcodeRaw) {
        App.masterIndex.set(barcodeRaw, item);
        const barcode14 = barcodeRaw.padStart(14, '0');
        App.masterIndex.set(barcode14, item);
      }

      // Store by RMS
      if (rms) {
        App.masterRMS.set(rms, item);
      }
    }
    console.log(`📋 Index built: ${App.masterIndex.size} keys, ${App.masterRMS.size} RMS codes`);
  },

  findProduct(input) {
    if (!input) return { name: '', rms: '', matchType: 'NONE' };
    const cleanInput = String(input).trim();
    const paddedInput = cleanInput.padStart(14, '0');

    // 1. Try GTIN/Barcode Index
    if (App.masterIndex.has(paddedInput)) {
      const item = App.masterIndex.get(paddedInput);
      return { ...item, matchType: 'EXACT_GTIN' };
    }

    if (App.masterIndex.has(cleanInput)) {
      const item = App.masterIndex.get(cleanInput);
      return { ...item, matchType: 'EXACT_BARCODE' };
    }

    // 2. Try RMS Direct
    if (App.masterRMS.has(cleanInput)) {
      const item = App.masterRMS.get(cleanInput);
      return { ...item, matchType: 'RMS_MATCH' };
    }

    return { name: '', rms: '', matchType: 'NONE' };
  }
};

// ============================================
// EXTERNAL API LOOKUPS
// ============================================
const API = {
  async lookup(gtin) {
    if (!App.settings.apiEnabled || !navigator.onLine) return null;
    const cleanGtin = gtin.replace(/\D/g, '').padStart(14, '0');
    let result = await this.brocade(cleanGtin);
    if (result) return result;
    result = await this.openFoodFacts(cleanGtin);
    if (result) return result;
    result = await this.upcItemDb(cleanGtin);
    if (result) return result;
    return null;
  },

  async brocade(gtin) {
    try {
      const res = await fetch(`https://www.brocade.io/api/items/${gtin}`, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.name) return { name: data.name, source: 'Brocade' };
    } catch (e) { console.log('Brocade API:', e.message); }
    return null;
  },

  async openFoodFacts(gtin) {
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data.status === 1 && data.product?.product_name) return { name: data.product.product_name, source: 'OpenFoodFacts' };
    } catch (e) { console.log('OpenFoodFacts API:', e.message); }
    return null;
  },

  async upcItemDb(gtin) {
    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${gtin}`, { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data.code === 'OK' && data.items?.[0]?.title) return { name: data.items[0].title, source: 'UPCitemdb' };
    } catch (e) { console.log('UPCitemdb API:', e.message); }
    return null;
  }
};

// ============================================
// BARCODE PROCESSING (UPDATED HIERARCHY)
// ============================================
async function processBarcode(code, options = {}) {
  const { silent = false, skipRefresh = false } = options;
  if (!code || typeof code !== 'string') return null;
  code = code.trim();
  if (!code) return null;

  const parsed = GS1.parse(code);
  let match = { name: '', rms: '', matchType: 'NONE' };

  // Step 1: Match by GS1 GTIN if it exists
  if (parsed.gtin) {
    match = Matcher.findProduct(parsed.gtin);
  }

  // Step 2: If no match, treat raw code as Barcode
  if (match.matchType === 'NONE') {
    match = Matcher.findProduct(code);
  }

  // Step 3: Try API if still not found
  if (match.matchType === 'NONE' && App.settings.apiEnabled && navigator.onLine) {
    const apiResult = await API.lookup(parsed.gtin || code);
    if (apiResult) {
      match = {
        name: apiResult.name,
        gtin: parsed.gtin || code,
        rms: 'API_NEW',
        barcode: code,
        matchType: 'API'
      };
      await DB.addMaster(match);
    }
  }

  const entry = {
    raw: parsed.raw,
    gtin: parsed.gtin || match.gtin || '',
    name: match.name || 'Unknown Product',
    rms: match.rms || '',
    matchType: match.matchType,
    expiry: parsed.expiry,
    expiryISO: parsed.expiryISO,
    expiryDisplay: parsed.expiryDisplay,
    batch: parsed.batch,
    serial: parsed.serial,
    qty: 1,
    supplier: match.supplier || '',
    price: match.price || '',
    brand: match.brand || '',
    category: match.category || '',
    returnable: match.returnStatus || '',
    timestamp: Date.now()
  };

  const id = await DB.addHistory(entry);
  entry.id = id;

  if (!silent) {
    const msg = match.matchType === 'NONE' ? 'Unknown Product' : match.name;
    toast(`Added: ${msg}`, match.matchType === 'NONE' ? 'info' : 'success');
    vibrate('success');
  }

  if (!skipRefresh) await refreshUI();
  return entry;
}

// ============================================
// BULK PROCESSING
// ============================================
async function processBulk() {
  const textarea = document.getElementById('inputBulk');
  const text = textarea.value.trim();
  if (!text) { toast('No barcodes to process', 'warning'); return; }
  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);

  const progressBar = document.getElementById('bulkProgress');
  const progressFill = document.getElementById('bulkProgressFill');
  const progressText = document.getElementById('bulkProgressText');
  const btn = document.getElementById('btnProcessBulk');

  progressBar.classList.add('active');
  progressText.classList.add('active');
  btn.disabled = true;

  let success = 0; let failed = 0;
  for (let i = 0; i < lines.length; i++) {
    try {
      const result = await processBarcode(lines[i], { silent: true, skipRefresh: true });
      if (result) success++; else failed++;
    } catch (e) { failed++; }
    const percent = Math.round(((i + 1) / lines.length) * 100);
    progressFill.style.width = percent + '%';
    progressText.textContent = `Processing ${i + 1} of ${lines.length}...`;
    if (i % 20 === 0) await sleep(10);
  }

  progressText.textContent = `Done! ${success} added, ${failed} failed`;
  btn.disabled = false;
  await refreshUI();
  textarea.value = '';
  updateBulkCount();
  toast(`Processed ${success} barcodes`, 'success');
  vibrate('success');
  setTimeout(() => {
    progressBar.classList.remove('active');
    progressText.classList.remove('active');
  }, 3000);
}

function updateBulkCount() {
  const textarea = document.getElementById('inputBulk');
  const countEl = document.getElementById('bulkCount');
  if (!textarea || !countEl) return;
  const lines = textarea.value.trim().split(/[\r\n]+/).filter(l => l.trim()).length;
  countEl.textContent = lines > 0 ? `${lines} line${lines !== 1 ? 's' : ''}` : '0 lines';
}

function toggleBulk() {
  const area = document.getElementById('bulkArea');
  const toggle = document.getElementById('bulkToggle');
  area.classList.toggle('hidden');
  toggle.classList.toggle('collapsed');
}

// ============================================
// CAMERA SCANNER
// ============================================
const Scanner = {
  async init() {
    try {
      App.scanner.cameras = await Html5Qrcode.getCameras();
      if (App.scanner.cameras.length === 0) { toast('No camera found', 'error'); return false; }
      const backIdx = App.scanner.cameras.findIndex(c =>
        c.label.toLowerCase().includes('back') || c.label.toLowerCase().includes('rear') || c.label.toLowerCase().includes('environment')
      );
      App.scanner.currentCamera = backIdx >= 0 ? backIdx : 0;
      return true;
    } catch (e) { toast('Camera access denied', 'error'); return false; }
  },
  async toggle() { App.scanner.active ? await this.stop() : await this.start(); },
  async start() {
    if (App.scanner.cameras.length === 0) { const ok = await this.init(); if (!ok) return; }
    try {
      App.scanner.instance = new Html5Qrcode('reader');
      const config = {
        fps: 10, qrbox: { width: 250, height: 250 },
        formatsToSupport: [
          Html5QrcodeSupportedFormats.QR_CODE, Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.CODE_128, Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13, Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A, Html5QrcodeSupportedFormats.ITF
        ]
      };
      await App.scanner.instance.start(App.scanner.cameras[App.scanner.currentCamera].id, config, this.onScan.bind(this), () => { });
      App.scanner.active = true;
      document.getElementById('scannerBox').classList.add('active');
      document.getElementById('btnScanner').innerHTML = '<span>⏹️</span> Stop Scanner';
      document.getElementById('btnScanner').classList.add('active');
      vibrate('medium');
    } catch (e) { toast('Scanner error', 'error'); }
  },
  async stop() {
    if (!App.scanner.instance) return;
    try { await App.scanner.instance.stop(); App.scanner.instance.clear(); } catch (e) { }
    App.scanner.active = false; App.scanner.instance = null;
    document.getElementById('scannerBox').classList.remove('active');
    document.getElementById('btnScanner').innerHTML = '<span>📷</span> Open Camera';
    document.getElementById('btnScanner').classList.remove('active');
  },
  async onScan(decodedText) {
    await this.stop();
    document.getElementById('inputBarcode').value = decodedText;
    await processBarcode(decodedText);
  }
};

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  await Promise.all([refreshStats(), refreshRecent(), refreshHistory(), refreshMasterCount()]);
}

async function refreshStats() {
  const history = await DB.getAllHistory();
  let expired = 0, expiring = 0, ok = 0;
  for (const item of history) {
    const status = GS1.getExpiryStatus(item.expiryISO);
    if (status === 'expired') expired++; else if (status === 'expiring') expiring++; else if (status === 'ok') ok++;
  }
  document.getElementById('statExpired').textContent = expired;
  document.getElementById('statExpiring').textContent = expiring;
  document.getElementById('statOk').textContent = ok;
}

async function refreshRecent() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  const container = document.getElementById('recentList');
  if (history.length === 0) {
    container.innerHTML = `<div class="empty-state"><div class="empty-icon">📦</div><div>No items yet</div></div>`;
    return;
  }
  container.innerHTML = history.slice(0, 10).map(item => renderItemCard(item)).join('');
}

async function refreshHistory() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);
  let filtered = history;
  if (App.filter !== 'all') filtered = history.filter(h => GS1.getExpiryStatus(h.expiryISO) === App.filter);
  if (App.search) {
    const q = App.search.toLowerCase();
    filtered = filtered.filter(h => (h.name?.toLowerCase().includes(q)) || (h.gtin?.includes(q)) || (h.rms?.includes(q)));
  }
  const container = document.getElementById('historyList');
  if (filtered.length === 0) {
    container.innerHTML = `<div class="empty-state">No items found</div>`;
    return;
  }
  container.innerHTML = filtered.map(item => renderItemCard(item, true)).join('');
}

function renderItemCard(item, showActions = true) {
  const status = GS1.getExpiryStatus(item.expiryISO);
  return `
    <div class="item-card ${status}" data-id="${item.id}">
      <div class="item-header">
        <span class="item-name">${escapeHtml(item.name)}</span>
        <span class="item-badge">${item.expiryDisplay || 'No expiry'}</span>
      </div>
      <div class="item-details">
        <div><span>GTIN:</span> ${item.gtin || '-'}</div>
        <div><span>RMS:</span> ${item.rms || '-'}</div>
        <div><span>Batch:</span> ${item.batch || '-'}</div>
      </div>
      ${showActions ? `<div class="item-actions"><button onclick="editItem(${item.id})">✏️</button><button onclick="deleteItem(${item.id})">🗑️</button></div>` : ''}
    </div>`;
}

async function refreshMasterCount() {
  const master = await DB.getAllMaster();
  document.getElementById('masterCount').textContent = master.length;
  Matcher.buildIndex(master);
}

// ============================================
// EDIT & DELETE
// ============================================
async function editItem(id) {
  const item = await DB.getHistory(id);
  if (!item) return;
  document.getElementById('editId').value = id;
  document.getElementById('editName').value = item.name || '';
  document.getElementById('editGtin').value = item.gtin || '';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editModal').classList.add('active');
}

async function saveEdit() {
  const id = parseInt(document.getElementById('editId').value);
  const item = await DB.getHistory(id);
  const expiryISO = document.getElementById('editExpiry').value;
  if (expiryISO) {
    const d = new Date(expiryISO);
    item.expiryDisplay = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }
  item.name = document.getElementById('editName').value.trim();
  item.expiryISO = expiryISO;
  item.batch = document.getElementById('editBatch').value.trim();
  item.qty = parseInt(document.getElementById('editQty').value) || 1;
  item.rms = document.getElementById('editRms').value.trim();
  await DB.updateHistory(item);
  closeModal(); await refreshUI(); toast('Item updated', 'success');
}

function closeModal() { document.getElementById('editModal').classList.remove('active'); }
async function deleteItem(id) { if (confirm('Delete?')) { await DB.deleteHistory(id); refreshUI(); } }

// ============================================
// MASTER DATA MANAGEMENT (UPDATED LOADER)
// ============================================
async function uploadMaster(file, append = false) {
  showLoading('Processing Master Data...');
  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);
    const header = lines[0].toLowerCase();
    const delim = header.includes('\t') ? '\t' : ',';
    const cols = header.split(delim).map(c => c.trim().replace(/['"]/g, ''));

    // Updated column mapping logic
    const gtinIdx = cols.findIndex(c => ['gtin'].includes(c));
    const rmsIdx = cols.findIndex(c => ['rms', 'rmscode'].includes(c));
    const barcodeIdx = cols.findIndex(c => ['barcode', 'ean', 'upc'].includes(c));
    const nameIdx = cols.findIndex(c => ['name', 'description'].includes(c));
    const priceIdx = cols.findIndex(c => ['price'].includes(c));
    const supplierIdx = cols.findIndex(c => ['supplier'].includes(c));
    const brandIdx = cols.findIndex(c => ['brand'].includes(c));
    const categoryIdx = cols.findIndex(c => ['category'].includes(c));
    const returnIdx = cols.findIndex(c => ['return', 'returnable'].includes(c));

    if (rmsIdx === -1) { toast('RMS column is required', 'error'); hideLoading(); return; }

    if (!append) await DB.clearMaster();

    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/['"]/g, ''));
      if (row.length < 2) continue;

      items.push({
        gtin: gtinIdx >= 0 ? row[gtinIdx] : '',
        rms: row[rmsIdx],
        barcode: barcodeIdx >= 0 ? row[barcodeIdx] : '',
        name: nameIdx >= 0 ? row[nameIdx] : 'Unknown',
        price: priceIdx >= 0 ? row[priceIdx] : '',
        supplier: supplierIdx >= 0 ? row[supplierIdx] : '',
        brand: brandIdx >= 0 ? row[brandIdx] : '',
        category: categoryIdx >= 0 ? row[categoryIdx] : '',
        returnStatus: returnIdx >= 0 ? row[returnIdx] : ''
      });
    }

    const count = await DB.bulkAddMaster(items);
    await refreshMasterCount();
    toast(`Loaded ${count} RMS records`, 'success');
  } catch (e) { toast('Upload failed', 'error'); }
  hideLoading();
}

function downloadTemplate() {
  const template = `gtin,rms,barcode,name,price,supplier,brand,category,return\n06291107439358,220155,6291107439358,Zyrtec 75ml,25.50,MPC,Zyrtec,Pharmacy,Yes`;
  downloadFile(template, 'master-template.csv', 'text/csv');
}

// ============================================
// EXPORT & BACKUP
// ============================================
async function exportCSV() {
  const history = await DB.getAllHistory();
  if (history.length === 0) return;
  const headers = ['RMS', 'GTIN', 'BARCODE', 'DESCRIPTION', 'EXPIRY', 'BATCH', 'QTY', 'SUPPLIER', 'RETURN'];
  let csv = headers.join(',') + '\n';
  history.forEach(h => {
    csv += `"${h.rms}","${h.gtin}","${h.barcode || ''}","${h.name}","${h.expiryDisplay}","${h.batch}",${h.qty},"${h.supplier}","${h.returnable}"\n`;
  });
  downloadFile(csv, `expiry-report-${formatDate(new Date())}.csv`, 'text/csv');
}

async function downloadBackup() {
  const history = await DB.getAllHistory();
  const master = await DB.getAllMaster();
  const backup = { version: CONFIG.VERSION, timestamp: Date.now(), history, master };
  downloadFile(JSON.stringify(backup), `backup-${formatDate(new Date())}.json`, 'application/json');
}

async function restoreBackup(file) {
  showLoading('Restoring...');
  try {
    const backup = JSON.parse(await file.text());
    if (backup.history) { await DB.clearHistory(); for (let h of backup.history) { delete h.id; await DB.addHistory(h); } }
    if (backup.master) { await DB.clearMaster(); await DB.bulkAddMaster(backup.master); }
    await refreshUI(); await refreshMasterCount();
    toast('Restore complete', 'success');
  } catch (e) { toast('Restore failed', 'error'); }
  hideLoading();
}

// ============================================
// UTILITIES & NAVIGATION
// ============================================
function showPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.getElementById(`page-${pageId}`).classList.add('active');
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-btn[data-page="${pageId}"]`)?.classList.add('active');
  if (pageId !== 'home' && App.scanner.active) Scanner.stop();
  closeMenu();
}

function openMenu() { document.getElementById('sideMenu').classList.add('active'); document.getElementById('menuOverlay').classList.add('active'); }
function closeMenu() { document.getElementById('sideMenu').classList.remove('active'); document.getElementById('menuOverlay').classList.remove('active'); }

function toast(msg, type = 'info') {
  const el = document.createElement('div'); el.className = `toast ${type}`; el.textContent = msg;
  document.getElementById('toasts').appendChild(el);
  setTimeout(() => { el.style.opacity = '0'; setTimeout(() => el.remove(), 300); }, 3000);
}

function showLoading(text) { document.getElementById('loadingText').textContent = text; document.getElementById('loading').classList.add('active'); }
function hideLoading() { document.getElementById('loading').classList.remove('active'); }
function vibrate(t) { if (navigator.vibrate) navigator.vibrate(t === 'success' ? [30, 50, 30] : 10); }
function escapeHtml(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
function formatDate(d) { return d.toISOString().split('T')[0].replace(/-/g, ''); }
function downloadFile(c, f, m) {
  const b = new Blob([c], { type: m }); const u = URL.createObjectURL(b);
  const a = document.createElement('a'); a.href = u; a.download = f; a.click();
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ============================================
// INITIALIZATION
// ============================================
function setupEvents() {
  const input = document.getElementById('inputBarcode');
  input.addEventListener('keydown', e => { if (e.key === 'Enter') { processBarcode(input.value); input.value = ''; } });
  document.getElementById('btnProcessBulk').addEventListener('click', processBulk);
  document.getElementById('btnScanner').addEventListener('click', () => Scanner.toggle());
  document.querySelectorAll('.nav-btn').forEach(b => b.addEventListener('click', () => showPage(b.dataset.page)));
  document.getElementById('btnMenu').addEventListener('click', openMenu);
  document.getElementById('menuOverlay').addEventListener('click', closeMenu);
  document.getElementById('fileMaster').addEventListener('change', e => uploadMaster(e.target.files[0]));
  document.getElementById('fileRestore').addEventListener('change', e => restoreBackup(e.target.files[0]));
}

async function init() {
  try {
    await DB.init();
    await refreshMasterCount();
    await refreshUI();
    setupEvents();
    document.getElementById('splash').classList.add('hidden');
    document.getElementById('app').classList.add('visible');
  } catch (e) { console.error(e); }
}

init();

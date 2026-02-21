/**
 * EXPIRY TRACKER v5.2.0
 * Complete Pharmacy Expiry Tracking PWA
 * Features: GS1 Parser, GTIN-RMS Matching, API Lookup, Bulk Processing, Camera Scanner
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
  masterIndex: new Map(),
  masterRMS: new Map(),
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
        
        // History store
        if (!db.objectStoreNames.contains('history')) {
          const historyStore = db.createObjectStore('history', { keyPath: 'id', autoIncrement: true });
          historyStore.createIndex('gtin', 'gtin', { unique: false });
          historyStore.createIndex('timestamp', 'timestamp', { unique: false });
        }
        
        // Master store
        if (!db.objectStoreNames.contains('master')) {
          const masterStore = db.createObjectStore('master', { keyPath: 'barcode' });
          masterStore.createIndex('name', 'name', { unique: false });
        }
        
        // Settings store
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        
        console.log('📦 Database upgraded');
      };
    });
  },

  // Generic transaction helper
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

  // History operations
  async addHistory(item) {
    return this._tx('history', 'readwrite', s => s.add(item));
  },

  async updateHistory(item) {
    return this._tx('history', 'readwrite', s => s.put(item));
  },

  async getHistory(id) {
    return this._tx('history', 'readonly', s => s.get(id));
  },

  async getAllHistory() {
    return this._tx('history', 'readonly', s => s.getAll());
  },

  async deleteHistory(id) {
    return this._tx('history', 'readwrite', s => s.delete(id));
  },

  async clearHistory() {
    return this._tx('history', 'readwrite', s => s.clear());
  },

  // Master operations
  async addMaster(item) {
    return this._tx('master', 'readwrite', s => s.put(item));
  },

  async getAllMaster() {
    return this._tx('master', 'readonly', s => s.getAll());
  },

  async clearMaster() {
    return this._tx('master', 'readwrite', s => s.clear());
  },

  async bulkAddMaster(items) {
    return new Promise((resolve, reject) => {
      const tx = App.db.transaction('master', 'readwrite');
      const store = tx.objectStore('master');
      let count = 0;
      
      for (const item of items) {
        if (item.barcode) {
          store.put(item);
          count++;
        }
      }
      
      tx.oncomplete = () => resolve(count);
      tx.onerror = () => reject(tx.error);
    });
  },

  // Settings
  async getSetting(key, defaultValue = null) {
    try {
      const result = await this._tx('settings', 'readonly', s => s.get(key));
      return result ? result.value : defaultValue;
    } catch {
      return defaultValue;
    }
  },

  async setSetting(key, value) {
    return this._tx('settings', 'readwrite', s => s.put({ key, value }));
  }
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

    // Check for GS1 format (contains AIs)
    const hasAI = code.includes('(') || /^01\d{14}/.test(code);

    if (!hasAI) {
      // Plain barcode
      const digits = code.replace(/\D/g, '');
      if (digits.length >= 8 && digits.length <= 14) {
        result.gtin = digits.padStart(14, '0');
      }
      return result;
    }

    result.isGS1 = true;

    // Parse GTIN (01)
    const gtinMatch = code.match(/\(01\)(\d{14})|^01(\d{14})/);
    if (gtinMatch) {
      result.gtin = gtinMatch[1] || gtinMatch[2];
    }

    // Parse Expiry (17)
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

    // Parse Batch (10)
    const batchMatch = code.match(/\(10\)([^\(]+)|10([A-Za-z0-9\-]+)/);
    if (batchMatch) {
      result.batch = (batchMatch[1] || batchMatch[2] || '').replace(/[^\w\-]/g, '').substring(0, 20);
    }

    // Parse Serial (21)
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
// PRODUCT MATCHING
// ============================================
const Matcher = {
  buildIndex(masterData) {
    App.masterIndex.clear();
    App.masterRMS.clear();

    for (const item of masterData) {
      const barcode = String(item.barcode || '').replace(/\D/g, '');
      const name = item.name || '';
      const rms = item.rms || '';

      if (!barcode || barcode.length < 8) continue;

      // Index by various formats
      App.masterIndex.set(barcode, name);

      const gtin14 = barcode.padStart(14, '0');
      App.masterIndex.set(gtin14, name);

      // GTIN-13 (without leading zero)
      if (gtin14.startsWith('0')) {
        App.masterIndex.set(gtin14.slice(1), name);
      }

      // Last 8 digits
      const last8 = barcode.slice(-8);
      if (!App.masterIndex.has(last8)) {
        App.masterIndex.set(last8, name);
      }

      // RMS mapping
      if (rms) {
        App.masterRMS.set(barcode, rms);
        App.masterRMS.set(gtin14, rms);
      }
    }

    console.log(`📋 Index built: ${App.masterIndex.size} entries`);
  },

  findProduct(gtin) {
    if (!gtin) return { name: '', rms: '', matchType: 'NONE' };

    // Exact match
    if (App.masterIndex.has(gtin)) {
      return {
        name: App.masterIndex.get(gtin),
        rms: App.masterRMS.get(gtin) || '',
        matchType: 'EXACT'
      };
    }

    // GTIN-13
    const gtin13 = gtin.startsWith('0') ? gtin.slice(1) : gtin;
    if (App.masterIndex.has(gtin13)) {
      return {
        name: App.masterIndex.get(gtin13),
        rms: App.masterRMS.get(gtin13) || '',
        matchType: 'GTIN13'
      };
    }

    // Last 8 digits
    const last8 = gtin.slice(-8);
    if (App.masterIndex.has(last8)) {
      return {
        name: App.masterIndex.get(last8),
        rms: App.masterRMS.get(last8) || '',
        matchType: 'LAST8'
      };
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

    // Try Brocade (best for medicines)
    let result = await this.brocade(cleanGtin);
    if (result) return result;

    // Try OpenFoodFacts
    result = await this.openFoodFacts(cleanGtin);
    if (result) return result;

    // Try UPCitemdb
    result = await this.upcItemDb(cleanGtin);
    if (result) return result;

    return null;
  },

  async brocade(gtin) {
    try {
      const res = await fetch(`https://www.brocade.io/api/items/${gtin}`, {
        signal: AbortSignal.timeout(5000)
      });
      if (!res.ok) return null;
      const data = await res.json();
      if (data.name) {
        return { name: data.name, source: 'Brocade' };
      }
    } catch (e) {
      console.log('Brocade API:', e.message);
    }
    return null;
  },

  async openFoodFacts(gtin) {
    try {
      const res = await fetch(`https://world.openfoodfacts.org/api/v2/product/${gtin}.json`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.status === 1 && data.product?.product_name) {
        return { name: data.product.product_name, source: 'OpenFoodFacts' };
      }
    } catch (e) {
      console.log('OpenFoodFacts API:', e.message);
    }
    return null;
  },

  async upcItemDb(gtin) {
    try {
      const res = await fetch(`https://api.upcitemdb.com/prod/trial/lookup?upc=${gtin}`, {
        signal: AbortSignal.timeout(5000)
      });
      const data = await res.json();
      if (data.code === 'OK' && data.items?.[0]?.title) {
        return { name: data.items[0].title, source: 'UPCitemdb' };
      }
    } catch (e) {
      console.log('UPCitemdb API:', e.message);
    }
    return null;
  }
};

// ============================================
// BARCODE PROCESSING
// ============================================
async function processBarcode(code, options = {}) {
  const { silent = false, skipRefresh = false } = options;

  if (!code || typeof code !== 'string') return null;
  code = code.trim();
  if (!code) return null;

  // Parse GS1
  const parsed = GS1.parse(code);

  // If no GTIN found, try to use raw as barcode
  if (!parsed.gtin) {
    const digits = code.replace(/\D/g, '');
    if (digits.length >= 8) {
      parsed.gtin = digits.padStart(14, '0');
    } else {
      if (!silent) toast('Invalid barcode format', 'warning');
      return null;
    }
  }

  // Find product in master
  let match = Matcher.findProduct(parsed.gtin);

  // Try API if not found
  if (!match.name && App.settings.apiEnabled && navigator.onLine) {
    const apiResult = await API.lookup(parsed.gtin);
    if (apiResult) {
      match.name = apiResult.name;
      match.matchType = 'API';

      // Auto-save to master
      await DB.addMaster({
        barcode: parsed.gtin,
        name: apiResult.name,
        rms: ''
      });
    }
  }

  // Create history entry
  const entry = {
    raw: parsed.raw,
    gtin: parsed.gtin,
    name: match.name || 'Unknown Product',
    rms: match.rms || '',
    matchType: match.matchType,
    expiry: parsed.expiry,
    expiryISO: parsed.expiryISO,
    expiryDisplay: parsed.expiryDisplay,
    batch: parsed.batch,
    serial: parsed.serial,
    qty: 1,
    supplier: '',
    returnable: '',
    timestamp: Date.now()
  };

  // Save to history
  const id = await DB.addHistory(entry);
  entry.id = id;

  if (!silent) {
    if (match.matchType === 'API') {
      toast(`Found via API: ${entry.name}`, 'success');
    } else if (match.name) {
      toast(`Added: ${entry.name}`, 'success');
    } else {
      toast('Added: Unknown Product', 'info');
    }
    vibrate('success');
  }

  if (!skipRefresh) {
    await refreshUI();
  }

  return entry;
}

// ============================================
// BULK PROCESSING
// ============================================
async function processBulk() {
  const textarea = document.getElementById('inputBulk');
  const text = textarea.value.trim();

  if (!text) {
    toast('No barcodes to process', 'warning');
    return;
  }

  const lines = text.split(/[\r\n]+/).map(l => l.trim()).filter(l => l.length > 0);

  if (lines.length === 0) {
    toast('No valid lines found', 'warning');
    return;
  }

  // Show progress
  const progressBar = document.getElementById('bulkProgress');
  const progressFill = document.getElementById('bulkProgressFill');
  const progressText = document.getElementById('bulkProgressText');
  const btn = document.getElementById('btnProcessBulk');

  progressBar.classList.add('active');
  progressText.classList.add('active');
  btn.disabled = true;

  let success = 0;
  let failed = 0;

  for (let i = 0; i < lines.length; i++) {
    try {
      const result = await processBarcode(lines[i], { silent: true, skipRefresh: true });
      if (result) success++;
      else failed++;
    } catch (e) {
      failed++;
    }

    // Update progress
    const percent = Math.round(((i + 1) / lines.length) * 100);
    progressFill.style.width = percent + '%';
    progressText.textContent = `Processing ${i + 1} of ${lines.length}...`;

    // Yield to UI
    if (i % 20 === 0) await sleep(10);
  }

  // Done
  progressText.textContent = `Done! ${success} added, ${failed} failed`;
  btn.disabled = false;

  // Refresh UI
  await refreshUI();

  // Clear input
  textarea.value = '';
  updateBulkCount();

  toast(`Processed ${success} barcodes`, 'success');
  vibrate('success');

  // Hide progress after delay
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

  if (area.classList.contains('hidden')) {
    area.classList.remove('hidden');
    toggle.classList.remove('collapsed');
  } else {
    area.classList.add('hidden');
    toggle.classList.add('collapsed');
  }
}

// ============================================
// CAMERA SCANNER
// ============================================
const Scanner = {
  async init() {
    try {
      App.scanner.cameras = await Html5Qrcode.getCameras();
      if (App.scanner.cameras.length === 0) {
        toast('No camera found', 'error');
        return false;
      }

      // Prefer back camera
      const backIdx = App.scanner.cameras.findIndex(c =>
        c.label.toLowerCase().includes('back') ||
        c.label.toLowerCase().includes('rear') ||
        c.label.toLowerCase().includes('environment')
      );
      App.scanner.currentCamera = backIdx >= 0 ? backIdx : 0;

      return true;
    } catch (e) {
      toast('Camera access denied', 'error');
      return false;
    }
  },

  async toggle() {
    if (App.scanner.active) {
      await this.stop();
    } else {
      await this.start();
    }
  },

  async start() {
    if (App.scanner.cameras.length === 0) {
      const ok = await this.init();
      if (!ok) return;
    }

    try {
      App.scanner.instance = new Html5Qrcode('reader');

      const config = {
        fps: 10,
        qrbox: { width: 250, height: 250 },
        formatsToSupport: [
          Html5QrcodeSupportedFormats.QR_CODE,
          Html5QrcodeSupportedFormats.DATA_MATRIX,
          Html5QrcodeSupportedFormats.CODE_128,
          Html5QrcodeSupportedFormats.CODE_39,
          Html5QrcodeSupportedFormats.EAN_13,
          Html5QrcodeSupportedFormats.EAN_8,
          Html5QrcodeSupportedFormats.UPC_A,
          Html5QrcodeSupportedFormats.ITF
        ]
      };

      await App.scanner.instance.start(
        App.scanner.cameras[App.scanner.currentCamera].id,
        config,
        this.onScan.bind(this),
        () => { }
      );

      App.scanner.active = true;
      document.getElementById('scannerBox').classList.add('active');
      document.getElementById('btnScanner').innerHTML = '<span>⏹️</span> Stop Scanner';
      document.getElementById('btnScanner').classList.add('active');

      vibrate('medium');
    } catch (e) {
      console.error('Scanner error:', e);
      toast('Scanner error', 'error');
    }
  },

  async stop() {
    if (!App.scanner.instance) return;

    try {
      await App.scanner.instance.stop();
      App.scanner.instance.clear();
    } catch (e) { }

    App.scanner.active = false;
    App.scanner.instance = null;

    document.getElementById('scannerBox').classList.remove('active');
    document.getElementById('btnScanner').innerHTML = '<span>📷</span> Open Camera';
    document.getElementById('btnScanner').classList.remove('active');
  },

  async onScan(decodedText) {
    console.log('📷 Scanned:', decodedText);

    // Stop scanner
    await this.stop();

    // Put in input
    document.getElementById('inputBarcode').value = decodedText;

    // Process
    await processBarcode(decodedText);
  }
};

// ============================================
// UI REFRESH
// ============================================
async function refreshUI() {
  await Promise.all([
    refreshStats(),
    refreshRecent(),
    refreshHistory(),
    refreshMasterCount()
  ]);
}

async function refreshStats() {
  const history = await DB.getAllHistory();

  let expired = 0, expiring = 0, ok = 0;

  for (const item of history) {
    const status = GS1.getExpiryStatus(item.expiryISO);
    if (status === 'expired') expired++;
    else if (status === 'expiring') expiring++;
    else if (status === 'ok') ok++;
  }

  document.getElementById('statExpired').textContent = expired;
  document.getElementById('statExpiring').textContent = expiring;
  document.getElementById('statOk').textContent = ok;
}

async function refreshRecent() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);

  const recent = history.slice(0, 10);
  const container = document.getElementById('recentList');

  if (recent.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📦</div>
        <div class="empty-title">No items yet</div>
        <div class="empty-text">Scan or paste a barcode to start</div>
      </div>
    `;
    return;
  }

  container.innerHTML = recent.map(item => renderItemCard(item)).join('');
}

async function refreshHistory() {
  const history = await DB.getAllHistory();
  history.sort((a, b) => b.timestamp - a.timestamp);

  let filtered = history;

  // Apply filter
  if (App.filter !== 'all') {
    filtered = history.filter(h => GS1.getExpiryStatus(h.expiryISO) === App.filter);
  }

  // Apply search
  if (App.search) {
    const q = App.search.toLowerCase();
    filtered = filtered.filter(h =>
      (h.name && h.name.toLowerCase().includes(q)) ||
      (h.gtin && h.gtin.includes(q)) ||
      (h.batch && h.batch.toLowerCase().includes(q)) ||
      (h.rms && h.rms.includes(q))
    );
  }

  const container = document.getElementById('historyList');

  if (filtered.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🔍</div>
        <div class="empty-title">No items found</div>
        <div class="empty-text">Try a different filter or search</div>
      </div>
    `;
    return;
  }

  container.innerHTML = filtered.map(item => renderItemCard(item, true)).join('');
}

function renderItemCard(item, showActions = true) {
  const status = GS1.getExpiryStatus(item.expiryISO);
  const cardClass = item.matchType === 'API' ? 'api' : status;

  return `
    <div class="item-card ${cardClass}" data-id="${item.id}">
      <div class="item-header">
        <span class="item-name">${escapeHtml(item.name || 'Unknown')}</span>
        <span class="item-badge">${item.expiryDisplay || 'No expiry'}</span>
      </div>
      <div class="item-details">
        <div class="item-detail">
          <span class="item-detail-label">GTIN:</span>
          <span class="item-detail-value">${item.gtin || '-'}</span>
        </div>
        <div class="item-detail">
          <span class="item-detail-label">Batch:</span>
          <span class="item-detail-value">${item.batch || '-'}</span>
        </div>
        <div class="item-detail">
          <span class="item-detail-label">RMS:</span>
          <span class="item-detail-value">${item.rms || '-'}</span>
        </div>
        <div class="item-detail">
          <span class="item-detail-label">Qty:</span>
          <span class="item-detail-value">${item.qty || 1}</span>
        </div>
      </div>
      ${showActions ? `
        <div class="item-actions">
          <button class="item-btn edit" onclick="editItem(${item.id})">✏️ Edit</button>
          <button class="item-btn delete" onclick="deleteItem(${item.id})">🗑️ Delete</button>
        </div>
      ` : ''}
    </div>
  `;
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
  if (!item) {
    toast('Item not found', 'error');
    return;
  }

  document.getElementById('editId').value = id;
  document.getElementById('editName').value = item.name || '';
  document.getElementById('editGtin').value = item.gtin || '';
  document.getElementById('editExpiry').value = item.expiryISO || '';
  document.getElementById('editBatch').value = item.batch || '';
  document.getElementById('editQty').value = item.qty || 1;
  document.getElementById('editRms').value = item.rms || '';
  document.getElementById('editSupplier').value = item.supplier || '';
  document.getElementById('editReturnable').value = item.returnable || '';

  document.getElementById('editModal').classList.add('active');
}

async function saveEdit() {
  const id = parseInt(document.getElementById('editId').value);
  const item = await DB.getHistory(id);

  if (!item) {
    toast('Item not found', 'error');
    return;
  }

  const expiryISO = document.getElementById('editExpiry').value;
  let expiryDisplay = '';

  if (expiryISO) {
    const d = new Date(expiryISO);
    expiryDisplay = `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
  }

  item.name = document.getElementById('editName').value.trim();
  item.expiryISO = expiryISO;
  item.expiryDisplay = expiryDisplay;
  item.batch = document.getElementById('editBatch').value.trim();
  item.qty = parseInt(document.getElementById('editQty').value) || 1;
  item.rms = document.getElementById('editRms').value.trim();
  item.supplier = document.getElementById('editSupplier').value.trim();
  item.returnable = document.getElementById('editReturnable').value;

  await DB.updateHistory(item);

  // Update master if name provided
  if (item.name && item.gtin) {
    await DB.addMaster({
      barcode: item.gtin,
      name: item.name,
      rms: item.rms
    });
    await refreshMasterCount();
  }

  closeModal();
  await refreshUI();
  toast('Item updated', 'success');
}

function closeModal() {
  document.getElementById('editModal').classList.remove('active');
}

async function deleteItem(id) {
  if (!confirm('Delete this item?')) return;

  await DB.deleteHistory(id);
  await refreshUI();
  toast('Item deleted', 'success');
}

// ============================================
// MASTER DATA MANAGEMENT
// ============================================
async function uploadMaster(file, append = false) {
  showLoading('Uploading...');

  try {
    const text = await file.text();
    const lines = text.trim().split(/[\r\n]+/);

    if (lines.length < 2) {
      toast('Invalid file format', 'error');
      hideLoading();
      return;
    }

    // Parse header
    const header = lines[0].toLowerCase();
    const delim = header.includes('\t') ? '\t' : ',';
    const cols = header.split(delim).map(c => c.trim().replace(/['"]/g, ''));

    // Find columns
    const barcodeIdx = cols.findIndex(c => ['barcode', 'gtin', 'ean', 'upc', 'code'].includes(c));
    const nameIdx = cols.findIndex(c => ['name', 'description', 'product', 'productname'].includes(c));
    const rmsIdx = cols.findIndex(c => ['rms', 'rmscode', 'rms code', 'rms_code'].includes(c));

    if (barcodeIdx === -1) {
      toast('No barcode column found (need: barcode, gtin, ean, or code)', 'error');
      hideLoading();
      return;
    }

    if (!append) {
      await DB.clearMaster();
    }

    // Parse rows
    const items = [];
    for (let i = 1; i < lines.length; i++) {
      const row = lines[i].split(delim).map(c => c.trim().replace(/['"]/g, ''));
      const barcode = row[barcodeIdx];
      const name = nameIdx >= 0 ? row[nameIdx] : '';
      const rms = rmsIdx >= 0 ? row[rmsIdx] : '';

      if (barcode && barcode.length >= 8) {
        items.push({ barcode, name, rms });
      }
    }

    const count = await DB.bulkAddMaster(items);
    await refreshMasterCount();

    toast(`${append ? 'Appended' : 'Uploaded'} ${count} products`, 'success');
  } catch (e) {
    console.error('Upload error:', e);
    toast('Upload failed: ' + e.message, 'error');
  }

  hideLoading();
}

async function resetMaster() {
  if (!confirm('Reset all product data? This cannot be undone.')) return;

  await DB.clearMaster();
  await refreshMasterCount();
  toast('Master data cleared', 'success');
}

function downloadTemplate() {
  const template = `gtin,barcode,name,rms,description
06291107439358,06291107439358,Zyrtec 75ml Bottle,220155756,Zyrtec Solution 75ml
00840149658430,00840149658430,VIAGRA 100MG 4S,220153086,Viagra Tablets 100mg 4s
06285074002448,06285074002448,Yasmin 21s Blister,220164755,Yasmin Oral Contraceptive 21s
06291109120469,06291109120469,Panadol Advance 24s,220236078,Panadol Advance Tablets 24s
03664798031966,03664798031966,Telfast 180mg 30s,220172600,Telfast Antihistamine 180mg 30s`;

  downloadFile(template, 'master-template.csv', 'text/csv');
  toast('Template downloaded', 'success');
}

// ============================================
// EXPORT & BACKUP
// ============================================
async function exportCSV() {
  const history = await DB.getAllHistory();

  if (history.length === 0) {
    toast('No data to export', 'warning');
    return;
  }

  const headers = ['RMS', 'BARCODE', 'DESCRIPTION', 'EXPIRY', 'BATCH', 'QTY', 'RETURNABLE', 'SUPPLIER'];

  const rows = history.map(h => [
    h.rms || '',
    h.gtin || '',
    h.name || '',
    h.expiryDisplay || '',
    h.batch || '',
    h.qty || 1,
    h.returnable || '',
    h.supplier || ''
  ]);

  let csv = headers.join(',') + '\n';
  for (const row of rows) {
    csv += row.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',') + '\n';
  }

  downloadFile(csv, `expiry-export-${formatDate(new Date())}.csv`, 'text/csv');
  toast('Export downloaded', 'success');
}

async function downloadBackup() {
  const history = await DB.getAllHistory();
  const master = await DB.getAllMaster();

  const backup = {
    version: CONFIG.VERSION,
    timestamp: Date.now(),
    date: new Date().toISOString(),
    history,
    master
  };

  downloadFile(JSON.stringify(backup, null, 2), `backup-${formatDate(new Date())}.json`, 'application/json');
  toast('Backup downloaded', 'success');
}

async function restoreBackup(file) {
  showLoading('Restoring...');

  try {
    const text = await file.text();
    const backup = JSON.parse(text);

    if (!backup.history && !backup.master) {
      toast('Invalid backup file', 'error');
      hideLoading();
      return;
    }

    if (backup.history && backup.history.length > 0) {
      await DB.clearHistory();
      for (const item of backup.history) {
        delete item.id;
        await DB.addHistory(item);
      }
    }

    if (backup.master && backup.master.length > 0) {
      await DB.clearMaster();
      await DB.bulkAddMaster(backup.master);
    }

    await refreshUI();
    await refreshMasterCount();

    toast(`Restored ${backup.history?.length || 0} items, ${backup.master?.length || 0} products`, 'success');
  } catch (e) {
    console.error('Restore error:', e);
    toast('Restore failed', 'error');
  }

  hideLoading();
}

async function clearHistory() {
  if (!confirm('Clear all scanned items? This cannot be undone.')) return;

  await DB.clearHistory();
  await refreshUI();
  toast('History cleared', 'success');
}

// ============================================
// NAVIGATION
// ============================================
function showPage(pageId) {
  // Hide all pages
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));

  // Show target
  const page = document.getElementById(`page-${pageId}`);
  if (page) page.classList.add('active');

  // Update nav
  document.querySelectorAll('.nav-btn').forEach(n => n.classList.remove('active'));
  document.querySelector(`.nav-btn[data-page="${pageId}"]`)?.classList.add('active');

  // Stop scanner if leaving home
  if (pageId !== 'home' && App.scanner.active) {
    Scanner.stop();
  }

  closeMenu();
  vibrate('light');
}

function openMenu() {
  document.getElementById('menuOverlay').classList.add('active');
  document.getElementById('sideMenu').classList.add('active');
}

function closeMenu() {
  document.getElementById('menuOverlay').classList.remove('active');
  document.getElementById('sideMenu').classList.remove('active');
}

function filterBy(status) {
  App.filter = status;

  // Update tabs
  document.querySelectorAll('.filter-tab').forEach(t => {
    t.classList.toggle('active', t.dataset.filter === status);
  });

  refreshHistory();
  showPage('history');
}

// ============================================
// UTILITIES
// ============================================
function toast(message, type = 'info') {
  const container = document.getElementById('toasts');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);

  setTimeout(() => {
    el.style.opacity = '0';
    setTimeout(() => el.remove(), 300);
  }, 3000);
}

function showLoading(text = 'Loading...') {
  document.getElementById('loadingText').textContent = text;
  document.getElementById('loading').classList.add('active');
}

function hideLoading() {
  document.getElementById('loading').classList.remove('active');
}

function vibrate(type = 'light') {
  if (!navigator.vibrate) return;
  switch (type) {
    case 'light': navigator.vibrate(10); break;
    case 'medium': navigator.vibrate(30); break;
    case 'success': navigator.vibrate([30, 50, 30]); break;
    case 'error': navigator.vibrate([100, 50, 100]); break;
  }
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}${m}${d}`;
}

function downloadFile(content, filename, mimeType) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ============================================
// EVENT SETUP
// ============================================
function setupEvents() {
  // Single barcode input
  const inputBarcode = document.getElementById('inputBarcode');
  inputBarcode.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      processBarcode(inputBarcode.value);
      inputBarcode.value = '';
    }
  });

  inputBarcode.addEventListener('paste', () => {
    setTimeout(() => {
      processBarcode(inputBarcode.value);
      inputBarcode.value = '';
    }, 100);
  });

  // Bulk input
  document.getElementById('inputBulk').addEventListener('input', updateBulkCount);
  document.getElementById('inputBulk').addEventListener('paste', () => setTimeout(updateBulkCount, 100));
  document.getElementById('btnProcessBulk').addEventListener('click', processBulk);

  // Scanner
  document.getElementById('btnScanner').addEventListener('click', () => Scanner.toggle());

  // Navigation
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => showPage(btn.dataset.page));
  });

  // Menu
  document.getElementById('btnMenu').addEventListener('click', openMenu);
  document.getElementById('menuOverlay').addEventListener('click', closeMenu);

  // Search
  document.getElementById('inputSearch').addEventListener('input', (e) => {
    App.search = e.target.value;
    refreshHistory();
  });

  // Filter tabs
  document.querySelectorAll('.filter-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      App.filter = tab.dataset.filter;
      document.querySelectorAll('.filter-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      refreshHistory();
    });
  });

  // File inputs
  document.getElementById('fileMaster').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      uploadMaster(e.target.files[0], false);
      e.target.value = '';
    }
  });

  document.getElementById('fileAppend').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      uploadMaster(e.target.files[0], true);
      e.target.value = '';
    }
  });

  document.getElementById('fileRestore').addEventListener('change', (e) => {
    if (e.target.files[0]) {
      restoreBackup(e.target.files[0]);
      e.target.value = '';
    }
  });

  // API toggle
  const apiToggle = document.getElementById('toggleAPI');
  apiToggle.addEventListener('change', () => {
    App.settings.apiEnabled = apiToggle.checked;
    updateAPIIndicator();
    DB.setSetting('apiEnabled', apiToggle.checked);
  });

  document.getElementById('btnToggleAPI').addEventListener('click', () => {
    apiToggle.checked = !apiToggle.checked;
    App.settings.apiEnabled = apiToggle.checked;
    updateAPIIndicator();
    DB.setSetting('apiEnabled', apiToggle.checked);
  });

  // Modal
  document.getElementById('editModal').addEventListener('click', (e) => {
    if (e.target.id === 'editModal') closeModal();
  });
}

function updateAPIIndicator() {
  const indicator = document.querySelector('.api-indicator');
  if (App.settings.apiEnabled) {
    indicator.classList.remove('off');
    indicator.classList.add('on');
  } else {
    indicator.classList.remove('on');
    indicator.classList.add('off');
  }
}

// ============================================
// INITIALIZATION
// ============================================
async function init() {
  console.log('🚀 Expiry Tracker v' + CONFIG.VERSION + ' starting...');

  try {
    // Initialize database
    await DB.init();

    // Load settings
    App.settings.apiEnabled = await DB.getSetting('apiEnabled', true);
    document.getElementById('toggleAPI').checked = App.settings.apiEnabled;
    updateAPIIndicator();

    // Build master index
    await refreshMasterCount();

    // Refresh UI
    await refreshUI();

    // Setup events
    setupEvents();

    // Hide splash, show app
    setTimeout(() => {
      document.getElementById('splash').classList.add('hidden');
      document.getElementById('app').classList.add('visible');

      // Focus input
      setTimeout(() => {
        document.getElementById('inputBarcode').focus();
      }, 100);
    }, 2500);

    // Register service worker
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js')
        .then(() => console.log('✅ Service Worker registered'))
        .catch(e => console.log('SW registration failed:', e));
    }

    console.log('✅ App ready!');
  } catch (e) {
    console.error('Init error:', e);
    toast('Failed to initialize app', 'error');

    // Still show app
    document.getElementById('splash').classList.add('hidden');
    document.getElementById('app').classList.add('visible');
  }
}

// Start app
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init);
} else {
  init();
}

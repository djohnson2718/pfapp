const DB_NAME = 'pfapp-finance';
const DB_VERSION = 2;
const STORE_ACCOUNTS = 'accounts';

const initialAccounts = [
  { name: 'Wallet', category: 'Cash', balance: 850, date: '2026-06-01' },
  { name: 'Checking Account', category: 'Cash', balance: 2300, date: '2026-06-02' },
  { name: 'Savings', category: 'Cash', balance: 5200, date: '2026-06-01' },
  { name: 'Brokerage', category: 'Investments', balance: 13750, date: '2026-06-05' },
  { name: 'Retirement', category: 'Investments', balance: 18400, date: '2026-05-30' },
  { name: 'Stock Options', category: 'Equity', balance: 6200, date: '2026-05-31' }
];

function requestToPromise(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function openDb() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      let store;

      if (!db.objectStoreNames.contains(STORE_ACCOUNTS)) {
        store = db.createObjectStore(STORE_ACCOUNTS, {
          keyPath: 'id',
          autoIncrement: true
        });
        store.createIndex('category', 'category', { unique: false });
        store.createIndex('name', 'name', { unique: false });
        store.createIndex('date', 'date', { unique: false });
      } else {
        store = request.transaction.objectStore(STORE_ACCOUNTS);
        if (!store.indexNames.contains('date')) {
          store.createIndex('date', 'date', { unique: false });
        }
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

async function getStore(db, storeName, mode = 'readonly') {
  const tx = db.transaction(storeName, mode);
  return {
    store: tx.objectStore(storeName),
    tx
  };
}

export async function initDb() {
  const db = await openDb();
  const { store, tx } = await getStore(db, STORE_ACCOUNTS, 'readwrite');
  const count = await requestToPromise(store.count());

  if (count === 0) {
    for (const account of initialAccounts) {
      store.add(account);
    }
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(db);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getCurrentAccounts() {
  const db = await openDb();
  const { store } = await getStore(db, STORE_ACCOUNTS);
  const entries = await requestToPromise(store.getAll());

  const latestEntries = entries.reduce((map, entry) => {
    const current = map.get(entry.name);
    if (!current || entry.date > current.date || (entry.date === current.date && entry.id > current.id)) {
      map.set(entry.name, entry);
    }
    return map;
  }, new Map());

  return Array.from(latestEntries.values()).sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAccountEntries() {
  const db = await openDb();
  const { store } = await getStore(db, STORE_ACCOUNTS);
  const entries = await requestToPromise(store.getAll());
  return entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0));
}

export async function getAccountsByCategory(category) {
  const db = await openDb();
  const { store } = await getStore(db, STORE_ACCOUNTS);
  const index = store.index('category');
  const request = index.getAll(category);
  const accounts = await requestToPromise(request);
  return accounts;
}

export async function updateAccountBalance(accountId, balance, date) {
  const db = await openDb();
  const { store, tx } = await getStore(db, STORE_ACCOUNTS, 'readwrite');
  const account = await requestToPromise(store.get(accountId));
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const newEntry = {
    name: account.name,
    category: account.category,
    balance,
    date
  };
  store.add(newEntry);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(newEntry);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function exportDataAsJSON() {
  const entries = await getAccountEntries();
  return JSON.stringify(entries, null, 2);
}

export async function importDataFromJSON(jsonString) {
  const entries = JSON.parse(jsonString);
  if (!Array.isArray(entries)) {
    throw new Error('Invalid backup format');
  }

  const db = await openDb();
  const { store, tx } = await getStore(db, STORE_ACCOUNTS, 'readwrite');
  store.clear();

  for (const entry of entries) {
    store.put(entry);
  }

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(entries.length);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

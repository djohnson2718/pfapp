const DB_NAME = 'pfapp-finance';
const DB_VERSION = 3;
const STORE_ACCOUNTS = 'accounts';

const categories = [
  {id: "cash", name: "Cash/Credit", sortOrder: 1},
  {id: "tax", name: "Taxable Investments", sortOrder: 2},
  {id: "retirement", name: "Retirement", sortOrder: 3},
  {id: "hsa", name: "HSA", sortOrder: 4},
  {id: "edu", name: "Education", sortOrder: 5},
  {id: "other", name: "Other", sortOrder: 6}
];

const initialAccounts = [
  { id: "sample1", name: 'Wallet', category: 'cash', balance: 850, date: '2026-06-01' },
  { id: "sample2", name: 'Checking Account', category: 'cash', balance: 2300, date: '2026-06-02' },
  { id: "sample3", name: 'Savings', category: 'cash', balance: 5200, date: '2026-06-01' },
  { id: "sample4", name: 'Brokerage', category: 'tax', balance: 13750, date: '2026-06-05' },
  { id: "sample5", name: 'Retirement', category: 'retirement', balance: 18400, date: '2026-05-30' },
  { id: "sample6", name: 'Stock Options', category: 'tax', balance: 6200, date: '2026-05-31' }
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

      if (db.objectStoreNames.contains(STORE_ACCOUNTS)) {
        db.deleteObjectStore(STORE_ACCOUNTS);
      }

      const store = db.createObjectStore(STORE_ACCOUNTS, {
        keyPath: 'id',
        autoIncrement: true
      });
      store.createIndex('category', 'category', { unique: false });
      store.createIndex('name', 'name', { unique: false });
      store.createIndex('date', 'date', { unique: false });
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

export async function updateAccountBalance(accountId, balance, date, category) {
  const db = await openDb();
  const { store, tx } = await getStore(db, STORE_ACCOUNTS, 'readwrite');
  const account = await requestToPromise(store.get(accountId));
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const newEntry = {
    name: account.name,
    category: category ?? account.category,
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

export async function addAccount(name, category, balance, date) {
  const db = await openDb();
  const { store, tx } = await getStore(db, STORE_ACCOUNTS, 'readwrite');
  const newAccount = {
    name,
    category,
    balance,
    date
  };
  store.add(newAccount);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(newAccount);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteAccount(accountId) {
  const db = await openDb();
  const { store, tx } = await getStore(db, STORE_ACCOUNTS, 'readwrite');
  const account = await requestToPromise(store.get(accountId));
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  const index = store.index('name');
  const request = index.openCursor(IDBKeyRange.only(account.name));

  return new Promise((resolve, reject) => {
    request.onsuccess = (event) => {
      const cursor = event.target.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
    request.onerror = () => reject(request.error);
    tx.oncomplete = () => resolve(true);
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

const DB_NAME = 'pfapp-finance';
const DB_VERSION = 4;
const STORE_ACCOUNTS = 'accounts';
const STORE_SNAPSHOTS = 'snapshots';

const categories = [
  {id: 'cash', name: 'Cash/Credit', sortOrder: 1},
  {id: 'tax', name: 'Taxable Investments', sortOrder: 2},
  {id: 'retirement', name: 'Retirement', sortOrder: 3},
  {id: 'hsa', name: 'HSA', sortOrder: 4},
  {id: 'edu', name: 'Education', sortOrder: 5},
  {id: 'other', name: 'Other', sortOrder: 6}
];

const initialAccounts = [
  { id: 'sample1', name: 'Wallet', category: 'cash', balance: 850, date: '2026-06-01' },
  { id: 'sample2', name: 'Checking Account', category: 'cash', balance: 2300, date: '2026-06-02' },
  { id: 'sample3', name: 'Savings', category: 'cash', balance: 5200, date: '2026-06-01' },
  { id: 'sample4', name: 'Brokerage', category: 'tax', balance: 13750, date: '2026-06-05' },
  { id: 'sample5', name: 'Retirement', category: 'retirement', balance: 18400, date: '2026-05-30' },
  { id: 'sample6', name: 'Stock Options', category: 'tax', balance: 6200, date: '2026-05-31' }
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
      if (db.objectStoreNames.contains(STORE_SNAPSHOTS)) {
        db.deleteObjectStore(STORE_SNAPSHOTS);
      }

      const accountsStore = db.createObjectStore(STORE_ACCOUNTS, {
        keyPath: 'id',
        autoIncrement: true
      });
      accountsStore.createIndex('category', 'category', { unique: false });
      accountsStore.createIndex('name', 'name', { unique: false });

      const snapshotsStore = db.createObjectStore(STORE_SNAPSHOTS, {
        keyPath: 'id',
        autoIncrement: true
      });
      snapshotsStore.createIndex('accountId', 'accountId', { unique: false });
      snapshotsStore.createIndex('date', 'date', { unique: false });
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

function getStores(db, storeNames, mode = 'readonly') {
  const tx = db.transaction(storeNames, mode);
  const stores = Object.fromEntries(storeNames.map((name) => [name, tx.objectStore(name)]));
  return { tx, stores };
}

export async function initDb() {
  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS], 'readwrite');
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];
  const count = await requestToPromise(accountsStore.count());

  if (count === 0) {
    for (const account of initialAccounts) {
      const key = await requestToPromise(accountsStore.add({ name: account.name, category: account.category }));
      await requestToPromise(snapshotsStore.add({ accountId: key, balance: account.balance, date: account.date }));
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
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS]);
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];

  const accounts = await requestToPromise(accountsStore.getAll());
  const snapshots = await requestToPromise(snapshotsStore.getAll());

  const latestByAccount = snapshots.reduce((map, snap) => {
    const current = map.get(snap.accountId);
    if (!current || snap.date > current.date || (snap.date === current.date && snap.id > current.id)) {
      map.set(snap.accountId, snap);
    }
    return map;
  }, new Map());

  const result = accounts.map((acct) => {
    const snap = latestByAccount.get(acct.id);
    return {
      id: acct.id,
      name: acct.name,
      category: acct.category,
      balance: snap?.balance ?? null,
      date: snap?.date ?? null
    };
  });

  return result.sort((a, b) => a.name.localeCompare(b.name));
}

export async function getAccountEntries() {
  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS]);
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];
  const accounts = await requestToPromise(accountsStore.getAll());
  const snapshots = await requestToPromise(snapshotsStore.getAll());

  const accountMap = new Map(accounts.map((a) => [a.id, a]));

  const entries = snapshots.map((s) => ({
    id: s.id,
    accountId: s.accountId,
    name: accountMap.get(s.accountId)?.name ?? 'Account',
    category: accountMap.get(s.accountId)?.category ?? 'other',
    balance: s.balance,
    date: s.date
  }));

  return entries.sort((a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0));
}

export async function getAccountsByCategory(category) {
  const db = await openDb();
  const { store: accountsStore } = await getStore(db, STORE_ACCOUNTS);
  const index = accountsStore.index('category');
  const request = index.getAll(category);
  const accounts = await requestToPromise(request);
  return accounts;
}

export async function updateAccountBalance(accountId, balance, date, category) {
  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS], 'readwrite');
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];
  const account = await requestToPromise(accountsStore.get(accountId));
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  if (category && category !== account.category) {
    account.category = category;
    accountsStore.put(account);
  }

  const snapshot = {
    accountId,
    balance,
    date
  };
  await requestToPromise(snapshotsStore.add(snapshot));

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(snapshot);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function addAccount(name, category, balance, date) {
  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS], 'readwrite');
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];

  const accountKey = await requestToPromise(accountsStore.add({ name, category }));
  const snapshot = { accountId: accountKey, balance, date };
  await requestToPromise(snapshotsStore.add(snapshot));

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve({ id: accountKey, name, category, balance, date });
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function deleteAccount(accountId) {
  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS], 'readwrite');
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];

  const account = await requestToPromise(accountsStore.get(accountId));
  if (!account) {
    throw new Error(`Account not found: ${accountId}`);
  }

  // delete snapshots for account
  const index = snapshotsStore.index('accountId');
  const request = index.openCursor(IDBKeyRange.only(accountId));
  request.onsuccess = (e) => {
    const cursor = e.target.result;
    if (cursor) {
      cursor.delete();
      cursor.continue();
    }
  };

  // delete account entry
  accountsStore.delete(accountId);

  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(true);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function exportDataAsJSON() {
  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS]);
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];
  const accounts = await requestToPromise(accountsStore.getAll());
  const snapshots = await requestToPromise(snapshotsStore.getAll());
  return JSON.stringify({ accounts, snapshots }, null, 2);
}

export async function importDataFromJSON(jsonString) {
  const payload = JSON.parse(jsonString);
  if (!payload || !Array.isArray(payload.accounts) || !Array.isArray(payload.snapshots)) {
    throw new Error('Invalid backup format');
  }

  const db = await openDb();
  const { tx, stores } = getStores(db, [STORE_ACCOUNTS, STORE_SNAPSHOTS], 'readwrite');
  const accountsStore = stores[STORE_ACCOUNTS];
  const snapshotsStore = stores[STORE_SNAPSHOTS];
  accountsStore.clear();
  snapshotsStore.clear();

  for (const acct of payload.accounts) {
    accountsStore.put(acct);
  }
  for (const snap of payload.snapshots) {
    snapshotsStore.put(snap);
  }

  const total = payload.accounts.length + payload.snapshots.length;
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve(total);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

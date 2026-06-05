<script>
  import { onMount, onDestroy } from 'svelte';
  import ApexCharts from 'apexcharts';
  import {
    initDb,
    getCurrentAccounts,
    getAccountEntries,
    updateAccountBalance,
    exportDataAsJSON,
    importDataFromJSON
  } from './lib/db.js';
  import {
    startGoogleSignIn,
    handleGoogleRedirect,
    ensureAccessToken,
    signOut as googleSignOut,
    getLatestBackupMeta,
    downloadBackup,
    uploadBackup
  } from './lib/drive.js';

  let accounts = [];
  const categories = ['Cash', 'Investments', 'Equity'];
  let loading = true;
  let error = '';
  let chartDiv;
  let chartInstance;
  let chartMode = 'pie';
  let historyEntries = [];
  let chartDates = [];
  let chartHistorySeries = [];
  let activeEditId = null;
  let activeForm = { balance: '', date: todayDate() };
  let signedIn = false;
  let localDirty = false;
  let driveMessage = '';
  let lastDriveSync = null;

  $: categoryTotals = categories.map((category) => ({
    category,
    total: accounts
      .filter((account) => account.category === category)
      .reduce((sum, account) => sum + (account.balance ?? 0), 0)
  }));

  $: totalAssets = categoryTotals.reduce((sum, item) => sum + item.total, 0);

  const pieChartOptions = {
    chart: { type: 'pie', toolbar: { show: false } },
    labels: categories,
    colors: ['#2c7be5', '#20c997', '#f59e0b'],
    legend: { position: 'bottom', horizontalAlign: 'center' },
    dataLabels: { enabled: true, formatter: (val) => `${val.toFixed(1)}%` },
    tooltip: { y: { formatter: (value) => `$${value.toLocaleString()}` } }
  };

  const lineChartOptions = {
    chart: { type: 'line', toolbar: { show: true } },
    stroke: { curve: 'straight', width: 3 },
    markers: { size: 0 },
    dataLabels: { enabled: false },
    colors: ['#2c7be5', '#20c997', '#f59e0b', '#9333ea'],
    legend: { position: 'bottom', horizontalAlign: 'center' },
    xaxis: {
      type: 'datetime',
      title: { text: 'Date' },
      tickAmount: 4,
      labels: {
        format: 'MM/dd'
      }
    },
    yaxis: {
      title: { text: 'Balance' },
      labels: { formatter: (val) => `$${val.toLocaleString()}` }
    },
    tooltip: { y: { formatter: (value) => `$${value.toLocaleString()}` } }
  };

  $: chartOptions =
    chartMode === 'pie'
      ? pieChartOptions
      : lineChartOptions;

  $: chartSeries =
    chartMode === 'pie'
      ? categoryTotals.map((item) => item.total)
      : chartHistorySeries;

  const formatter = new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: 'USD'
  });

  async function loadAccounts() {
    loading = true;
    error = '';

    try {
      await initDb();
      accounts = await getCurrentAccounts();
      historyEntries = await getAccountEntries();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  function getStoredSyncState() {
    const raw = localStorage.getItem('pfapp-drive-sync-state');
    if (!raw) return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function setStoredSyncState(state) {
    lastDriveSync = state;
    localStorage.setItem('pfapp-drive-sync-state', JSON.stringify(state));
  }

  async function loadStoredSyncState() {
    lastDriveSync = getStoredSyncState();
  }

  async function autoSyncOnLoad() {
    driveMessage = 'Checking Drive for newer backups...';
    const latest = await getLatestBackupMeta();
    const stored = getStoredSyncState();

    if (!latest) {
      driveMessage = 'No Drive backup found yet.';
      return;
    }

    if (!stored || new Date(latest.modifiedTime) > new Date(stored.modifiedTime)) {
      driveMessage = 'Loading newer Drive backup...';
      const content = await downloadBackup(latest.id);
      await importDataFromJSON(content);
      await loadAccounts();
      setStoredSyncState({ modifiedTime: latest.modifiedTime });
      localDirty = false;
      driveMessage = 'Loaded latest Drive backup from Drive.';
    } else {
      driveMessage = 'Drive is up to date.';
    }
  }

  async function handleSignIn() {
    try {
      await startGoogleSignIn();
    } catch (err) {
      error = err.message;
    }
  }

  async function handleSignOut() {
    googleSignOut();
    signedIn = false;
    driveMessage = 'Signed out of Google Drive.';
  }

  async function saveChangesToDrive() {
    try {
      if (!localDirty) {
        driveMessage = 'No local changes to save.';
        return;
      }

      const token = await ensureAccessToken();
      if (!token) {
        await startGoogleSignIn();
        return;
      }

      const latest = await getLatestBackupMeta();
      const stored = getStoredSyncState();

      if (latest && (!stored || new Date(latest.modifiedTime) > new Date(stored.modifiedTime))) {
        error = 'Drive has a newer version. Load it before uploading.';
        return;
      }

      if (latest && !stored) {
        error = 'Please load the latest Drive backup before uploading.';
        return;
      }

      const content = await exportDataAsJSON();
      const file = await uploadBackup(content);
      setStoredSyncState({ modifiedTime: file.modifiedTime });
      localDirty = false;
      driveMessage = `Saved changes to Drive as ${file.name}.`;
    } catch (err) {
      error = err.message;
    }
  }

  function todayDate() {
    return new Date().toISOString().slice(0, 10);
  }

  function getLastNDates(count) {
    const dates = [];
    const now = new Date();
    for (let i = count - 1; i >= 0; i -= 1) {
      const date = new Date(now);
      date.setDate(now.getDate() - i);
      dates.push(date.toISOString().slice(0, 10));
    }
    return dates;
  }

  function buildHistorySeries(entries) {
    const sortedEntries = [...entries].sort(
      (a, b) => a.date.localeCompare(b.date) || (a.id ?? 0) - (b.id ?? 0)
    );
    const dates = getLastNDates(30);
    const accountGroups = new Map();

    for (const entry of sortedEntries) {
      const key = `${entry.name}::${entry.category}`;
      if (!accountGroups.has(key)) {
        accountGroups.set(key, []);
      }
      accountGroups.get(key).push(entry);
    }

    const series = categories.map((category) => ({ name: category, data: [] }));
    const totalSeries = { name: 'Total', data: [] };

    for (const date of dates) {
      const totals = new Map(categories.map((category) => [category, 0]));
      let total = 0;

      for (const entries of accountGroups.values()) {
        const latest = [...entries].reverse().find((entry) => entry.date <= date);
        if (!latest) continue;
        const category = latest.category || 'Other';
        totals.set(category, (totals.get(category) ?? 0) + (latest.balance ?? 0));
        total += latest.balance ?? 0;
      }

      for (const seriesItem of series) {
        seriesItem.data.push({ x: date, y: totals.get(seriesItem.name) ?? 0 });
      }
      totalSeries.data.push({ x: date, y: total });
    }

    return { dates, series: [...series, totalSeries] };
  }

  $: ({ dates: chartDates, series: chartHistorySeries } = buildHistorySeries(historyEntries));

  function openEditModal(account) {
    activeEditId = account.id;
    activeForm = {
      balance: account.balance ?? '',
      date: todayDate()
    };
    error = '';
  }

  function closeEditModal() {
    activeEditId = null;
    error = '';
  }

  async function handleUpdate(accountId) {
    if (activeEditId !== accountId) return;

    const parsed = parseFloat(activeForm.balance);
    if (Number.isNaN(parsed)) {
      error = 'Invalid amount';
      return;
    }
    try {
      loading = true;
      await updateAccountBalance(accountId, parsed, activeForm.date);
      accounts = await getCurrentAccounts();
      historyEntries = await getAccountEntries();
      localDirty = true;
      closeEditModal();
    } catch (err) {
      error = err.message;
    } finally {
      loading = false;
    }
  }

  onMount(async () => {
    try {
      await handleGoogleRedirect();
    } catch (err) {
      error = err.message;
    }

    signedIn = Boolean(await ensureAccessToken());
    await loadStoredSyncState();
    await loadAccounts();

    if (signedIn) {
      try {
        await autoSyncOnLoad();
      } catch (err) {
        driveMessage = err.message;
      }
    }

    chartInstance = new ApexCharts(chartDiv, {
      ...chartOptions,
      series: chartSeries
    });
    chartInstance.render();
  });

  $: if (chartInstance && chartMode) {
    chartInstance.destroy();
    chartInstance = new ApexCharts(chartDiv, {
      ...chartOptions,
      series: chartSeries
    });
    chartInstance.render();
  }

  onDestroy(() => {
    chartInstance?.destroy();
  });
</script>

<style>
  :global(body) {
    margin: 0;
    font-family: system-ui, sans-serif;
    background: #f8fafc;
    color: #111827;
  }

  .app {
    max-width: 960px;
    margin: 0 auto;
    padding: 2rem 1rem;
  }

  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }

  h1 {
    margin: 0;
    font-size: 2rem;
  }

  .summary {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
    gap: 1rem;
    margin-top: 1.5rem;
  }

  .card {
    background: #ffffff;
    border: 1px solid #e5e7eb;
    border-radius: 1rem;
    padding: 1.25rem;
    box-shadow: 0 1px 3px rgba(15, 23, 42, 0.06);
  }

  .card h2 {
    margin: 0 0 0.75rem;
    font-size: 1rem;
    color: #6b7280;
  }

  .account-table {
    width: 100%;
    border-collapse: collapse;
    margin-top: 1rem;
  }

  .account-table th,
  .account-table td {
    text-align: left;
    padding: 0.75rem 0.5rem;
    border-bottom: 1px solid #e5e7eb;
  }

  .account-table th {
    color: #4b5563;
    font-weight: 700;
  }

  .badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    padding: 0.4rem 0.75rem;
    border-radius: 9999px;
    color: #111827;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }

  .chart-toggle {
    display: inline-flex;
    border: 1px solid #d1d5db;
    border-radius: 9999px;
    overflow: hidden;
    background: #f8fafc;
  }

  .chart-toggle button {
    border: none;
    background: transparent;
    color: #4b5563;
    padding: 0.55rem 0.9rem;
    cursor: pointer;
    font-weight: 600;
  }

  .chart-toggle button.selected,
  .chart-toggle button:focus,
  .chart-toggle button:hover {
    background: #2563eb;
    color: white;
  }

  .drive-controls {
    display: inline-flex;
    gap: 0.5rem;
    align-items: center;
  }

  .drive-controls button {
    padding: 0.65rem 0.85rem;
    border-radius: 0.75rem;
    border: 1px solid #d1d5db;
    background: white;
    color: #111827;
    cursor: pointer;
    font-weight: 600;
  }

  .drive-controls button:hover:not(:disabled) {
    background: #eef2ff;
  }

  .drive-controls button:disabled {
    opacity: 0.55;
    cursor: not-allowed;
  }

  .chart-panel {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
  }

  .chart-panel > div {
    width: 100%;
    max-width: 420px;
  }
  .chart-panel {
    position: relative;
    z-index: 0;
    overflow: visible;
  }
  .chart-panel > div {
    position: relative;
    z-index: 0;
  }
  .chart-panel :global(svg) {
    max-width: 100%;
    height: auto !important;
    display: block;
  }
  .account-table, .account-table th, .account-table td {
    position: relative;
    z-index: 1;
  }

  .modal-backdrop {
    position: fixed;
    inset: 0;
    background: rgba(15, 23, 42, 0.55);
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    z-index: 50;
    animation: fadeIn 180ms ease-out both;
  }

  .modal {
    background: #ffffff;
    border-radius: 1rem;
    box-shadow: 0 25px 50px rgba(15, 23, 42, 0.2);
    max-width: 420px;
    width: 100%;
    padding: 1.5rem;
    animation: popIn 180ms ease-out both;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
      backdrop-filter: blur(0px);
    }
    to {
      opacity: 1;
      backdrop-filter: blur(2px);
    }
  }

  @keyframes popIn {
    from {
      opacity: 0;
      transform: translateY(16px) scale(0.96);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  .modal h2 {
    margin-top: 0;
    margin-bottom: 0.75rem;
    font-size: 1.25rem;
  }

  .modal p {
    margin: 0 0 1rem;
    color: #6b7280;
  }

  .modal label {
    display: block;
    margin-bottom: 1rem;
    font-size: 0.95rem;
    color: #374151;
  }

  .modal input {
    width: 100%;
    margin-top: 0.35rem;
    padding: 0.75rem 0.85rem;
    border: 1px solid #d1d5db;
    border-radius: 0.75rem;
    font-size: 1rem;
  }

  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.75rem;
    margin-top: 1rem;
  }

  .modal-actions button {
    padding: 0.75rem 1rem;
    border-radius: 0.75rem;
    border: none;
    cursor: pointer;
    font-weight: 600;
  }

  .modal-actions button:hover {
    opacity: 0.95;
  }

  .modal-actions .secondary {
    background: #e5e7eb;
    color: #111827;
  }

  .modal-actions button:not(.secondary) {
    background: #2563eb;
    color: white;
  }
</style>

<div class="app">
  <div class="header">
    <div>
      <h1>Personal Finance Dashboard</h1>
      <p>Current account balances loaded from a local SQLite database.</p>
    </div>
    <div class="header-actions">
      <div class="chart-toggle">
        <button class:selected={chartMode === 'pie'} on:click={() => (chartMode = 'pie')}>Pie</button>
        <button class:selected={chartMode === 'line'} on:click={() => (chartMode = 'line')}>History</button>
      </div>
      <div class="drive-controls">
        {#if signedIn}
          <button on:click={handleSignOut}>Sign out</button>
        {:else}
          <button on:click={handleSignIn}>Sign in to Drive</button>
        {/if}
        <button on:click={saveChangesToDrive} disabled={!localDirty}>Save Changes</button>
      </div>
      <div class="badge" style="background:#e0f2fe; color:#0369a1">
        {loading ? 'Loading…' : formatter.format(totalAssets)}
      </div>
    </div>
  </div>

  {#if error}
    <div class="card" style="border-color:#bfdbfe; background:#eff6ff; margin-top:1rem;">
      {driveMessage}
    </div>
  {/if}

  <div class="summary">
    <div class="card">
      <h2>Current Balances</h2>
      {#if loading}
        <p>Loading current balances…</p>
      {:else}
        <table class="account-table">
          <thead>
            <tr>
              <th>Account</th>
              <th>Category</th>
              <th>Balance</th>
              <th>Date</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {#each accounts as account}
              <tr>
                <td>{account.name}</td>
                <td>{account.category}</td>
                <td>{account.balance !== null ? formatter.format(account.balance) : '—'}</td>
                <td>{account.date ? new Date(account.date).toLocaleDateString() : '—'}</td>
                <td>
                  <button on:click={() => openEditModal(account)}>Update</button>
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      {/if}
    </div>

    <div class="card">
      <h2>{chartMode === 'pie' ? 'Portfolio Distribution' : 'Balance History'}</h2>
      <div class="chart-panel">
        <div bind:this={chartDiv}></div>
      </div>
    </div>
  </div>

  {#if activeEditId !== null}
    <div
      class="modal-backdrop"
      role="button"
      tabindex="0"
      on:click={closeEditModal}
      on:keydown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          closeEditModal();
        }
      }}
    >
      <div class="modal" role="presentation" tabindex="-1" on:click|stopPropagation>
        <h2>Update account balance</h2>
        <p>{accounts.find((account) => account.id === activeEditId)?.name || 'Account'}</p>

        <label>
          Amount
          <input
            type="number"
            min="0"
            step="0.01"
            bind:value={activeForm.balance}
          />
        </label>

        <label>
          Date
          <input
            type="date"
            bind:value={activeForm.date}
          />
        </label>

        <div class="modal-actions">
          <button on:click={() => handleUpdate(activeEditId)}>Save</button>
          <button class="secondary" on:click={closeEditModal}>Cancel</button>
        </div>
      </div>
    </div>
  {/if}
</div>

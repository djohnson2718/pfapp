const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const GSI_SCRIPT_URL = 'https://accounts.google.com/gsi/client';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_STORAGE_KEY = 'pfapp-google-drive-tokens';
const BACKUP_FILE_PREFIX = 'pfapp-backup-';

let tokenClient = null;
let pendingTokenRequest = null;

function getStoredTokens() {
  const raw = localStorage.getItem(TOKEN_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function saveTokens(tokens) {
  localStorage.setItem(TOKEN_STORAGE_KEY, JSON.stringify(tokens));
}

function clearTokens() {
  localStorage.removeItem(TOKEN_STORAGE_KEY);
}

function assertClientId() {
  if (!CLIENT_ID) {
    throw new Error('Missing VITE_GOOGLE_CLIENT_ID environment variable');
  }
}

function loadGsiScript() {
  return new Promise((resolve, reject) => {
    if (window.google && window.google.accounts && window.google.accounts.oauth2) {
      return resolve();
    }

    const script = document.createElement('script');
    script.src = GSI_SCRIPT_URL;
    script.onload = () => resolve();
    script.onerror = () => reject(new Error('Failed to load Google Identity Services script'));
    document.head.appendChild(script);
  });
}

function initTokenClient() {
  if (tokenClient) {
    return;
  }

  tokenClient = window.google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID,
    scope: SCOPE,
    callback: (response) => {
      if (!pendingTokenRequest) {
        return;
      }

      const { resolve, reject } = pendingTokenRequest;
      pendingTokenRequest = null;

      if (response.error) {
        reject(new Error(response.error_description || response.error));
        return;
      }

      const expiresAt = Date.now() + (response.expires_in || 3600) * 1000 - 60000;
      const tokens = {
        access_token: response.access_token,
        expires_at: expiresAt
      };
      saveTokens(tokens);
      resolve(response.access_token);
    }
  });
}

async function ensureTokenClientReady() {
  assertClientId();
  await loadGsiScript();
  initTokenClient();
}

async function requestAccessToken({ prompt = '' } = {}) {
  await ensureTokenClientReady();

  if (!tokenClient) {
    throw new Error('Google OAuth token client not initialized');
  }

  if (pendingTokenRequest) {
    throw new Error('A token request is already in progress');
  }

  return new Promise((resolve, reject) => {
    pendingTokenRequest = { resolve, reject };
    tokenClient.requestAccessToken({ prompt });
  });
}

export async function startGoogleSignIn() {
  return requestAccessToken({ prompt: '' });
}

export async function handleGoogleRedirect() {
  return null;
}

export async function ensureAccessToken() {
  assertClientId();

  const tokens = getStoredTokens();
  if (tokens?.access_token && tokens.expires_at > Date.now()) {
    return tokens.access_token;
  }

  try {
    return await requestAccessToken({ prompt: '' });
  } catch {
    return null;
  }
}

export async function signOut() {
  const tokens = getStoredTokens();
  if (tokens?.access_token) {
    try {
      await fetch(`https://oauth2.googleapis.com/revoke?token=${encodeURIComponent(tokens.access_token)}`, {
        method: 'POST'
      });
    } catch {
      // ignore revoke errors
    }
  }

  clearTokens();
  tokenClient = null;
}

export function isSignedIn() {
  const tokens = getStoredTokens();
  return Boolean(tokens?.access_token && tokens.expires_at > Date.now());
}

async function authorizedFetch(url, options = {}) {
  const accessToken = await ensureAccessToken();
  if (!accessToken) {
    throw new Error('Not signed in to Google Drive');
  }

  const headers = {
    Authorization: `Bearer ${accessToken}`,
    ...(options.headers || {})
  };

  return fetch(url, { ...options, headers });
}

export async function getLatestBackupMeta() {
  const params = new URLSearchParams({
    spaces: 'appDataFolder',
    q: `name contains '${BACKUP_FILE_PREFIX}'`,
    orderBy: 'modifiedTime desc',
    pageSize: '1',
    fields: 'files(id,name,modifiedTime)'
  });

  const response = await authorizedFetch(`${DRIVE_FILES_ENDPOINT}?${params}`);
  if (!response.ok) {
    throw new Error('Failed to list Drive backups');
  }

  const data = await response.json();
  return data.files?.[0] ?? null;
}

export async function downloadBackup(fileId) {
  const response = await authorizedFetch(`${DRIVE_FILES_ENDPOINT}/${fileId}?alt=media`);
  if (!response.ok) {
    throw new Error('Failed to download Drive backup');
  }
  return response.text();
}

export async function uploadBackup(content) {
  const timestamp = new Date().toISOString();
  const fileName = `${BACKUP_FILE_PREFIX}${timestamp}.json`;
  const metadata = {
    name: fileName,
    parents: ['appDataFolder']
  };

  const boundary = `----pfapp${Date.now()}`;
  const bodyParts = [
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    JSON.stringify(metadata),
    `--${boundary}`,
    'Content-Type: application/json; charset=UTF-8',
    '',
    content,
    `--${boundary}--`
  ];

  const response = await authorizedFetch(`https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart`, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/related; boundary=${boundary}`
    },
    body: bodyParts.join('\r\n')
  });

  if (!response.ok) {
    throw new Error('Failed to upload Drive backup');
  }

  return response.json();
}

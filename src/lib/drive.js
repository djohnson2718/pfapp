const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID;
const REDIRECT_URI = import.meta.env.VITE_GOOGLE_REDIRECT_URI || window.location.origin;
const AUTH_ENDPOINT = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const DRIVE_FILES_ENDPOINT = 'https://www.googleapis.com/drive/v3/files';
const SCOPE = 'https://www.googleapis.com/auth/drive.appdata';
const TOKEN_STORAGE_KEY = 'pfapp-google-drive-tokens';
const OAUTH_STATE_KEY = 'pfapp-google-drive-oauth-state';
const PKCE_VERIFIER_KEY = 'pfapp-google-drive-pkce-verifier';
const BACKUP_FILE_PREFIX = 'pfapp-backup-';

function randomString(length) {
  const array = new Uint8Array(length);
  crypto.getRandomValues(array);
  return Array.from(array, (byte) => ('0' + (byte & 0xff).toString(16)).slice(-2)).join('');
}

function base64UrlEncode(buffer) {
  const bytes = new Uint8Array(buffer);
  let str = '';
  for (const byte of bytes) {
    str += String.fromCharCode(byte);
  }
  return btoa(str).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function sha256(value) {
  const data = new TextEncoder().encode(value);
  const hashed = await crypto.subtle.digest('SHA-256', data);
  return base64UrlEncode(hashed);
}

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

export function startGoogleSignIn() {
  assertClientId();
  const codeVerifier = randomString(64);
  const state = randomString(16);
  sessionStorage.setItem(PKCE_VERIFIER_KEY, codeVerifier);
  sessionStorage.setItem(OAUTH_STATE_KEY, state);

  return sha256(codeVerifier).then((codeChallenge) => {
    const params = new URLSearchParams({
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      response_type: 'code',
      scope: SCOPE,
      access_type: 'offline',
      include_granted_scopes: 'true',
      prompt: 'consent',
      state,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256'
    });

    window.location.href = `${AUTH_ENDPOINT}?${params}`;
  });
}

export async function handleGoogleRedirect() {
  const url = new URL(window.location.href);
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state');
  const error = url.searchParams.get('error');

  if (!code && !error) {
    return null;
  }

  const expectedState = sessionStorage.getItem(OAUTH_STATE_KEY);
  const codeVerifier = sessionStorage.getItem(PKCE_VERIFIER_KEY);
  sessionStorage.removeItem(OAUTH_STATE_KEY);
  sessionStorage.removeItem(PKCE_VERIFIER_KEY);

  url.searchParams.delete('code');
  url.searchParams.delete('state');
  url.searchParams.delete('error');
  window.history.replaceState({}, document.title, url.pathname + url.search);

  if (error) {
    throw new Error(error);
  }

  if (!codeVerifier || state !== expectedState) {
    throw new Error('OAuth validation failed');
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    code,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
    redirect_uri: REDIRECT_URI
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed: ${body}`);
  }

  const data = await response.json();
  const tokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 - 60000
  };
  saveTokens(tokens);
  return tokens;
}

export async function refreshAccessToken() {
  const tokens = getStoredTokens();
  if (!tokens?.refresh_token) {
    throw new Error('No refresh token available');
  }

  const params = new URLSearchParams({
    client_id: CLIENT_ID,
    grant_type: 'refresh_token',
    refresh_token: tokens.refresh_token
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params.toString()
  });

  if (!response.ok) {
    clearTokens();
    throw new Error('Failed to refresh token');
  }

  const data = await response.json();
  const refreshed = {
    ...tokens,
    access_token: data.access_token,
    expires_at: Date.now() + (data.expires_in ?? 3600) * 1000 - 60000
  };
  saveTokens(refreshed);
  return refreshed;
}

export async function ensureAccessToken() {
  assertClientId();
  let tokens = getStoredTokens();
  if (!tokens) {
    return null;
  }

  if (tokens.expires_at && tokens.expires_at > Date.now()) {
    return tokens.access_token;
  }

  try {
    tokens = await refreshAccessToken();
    return tokens.access_token;
  } catch {
    return null;
  }
}

export function signOut() {
  clearTokens();
}

export function isSignedIn() {
  const tokens = getStoredTokens();
  return Boolean(tokens?.access_token || tokens?.refresh_token);
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

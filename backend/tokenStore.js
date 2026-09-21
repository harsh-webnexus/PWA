import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, 'data');
const STORE_PATH = path.resolve(DATA_DIR, 'fcm-tokens.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_PATH)) fs.writeFileSync(STORE_PATH, '[]', 'utf8');
}

function readAll() {
  ensureStore();
  try {
    const raw = fs.readFileSync(STORE_PATH, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeAll(rows) {
  ensureStore();
  fs.writeFileSync(STORE_PATH, JSON.stringify(rows, null, 2), 'utf8');
}

export function listTokens() {
  return readAll();
}

export function upsertToken({ token, userAgent = '', label = '' }) {
  const clean = String(token || '').trim();
  if (!clean) throw new Error('token is required');

  const now = new Date().toISOString();
  const rows = readAll();
  const existing = rows.find((row) => row.token === clean);

  if (existing) {
    existing.updatedAt = now;
    existing.userAgent = userAgent || existing.userAgent;
    existing.label = label || existing.label;
    writeAll(rows);
    console.log('[tokens] Updated existing FCM token');
    return existing;
  }

  const row = {
    id: crypto.randomUUID(),
    token: clean,
    userAgent,
    label,
    createdAt: now,
    updatedAt: now,
  };
  rows.push(row);
  writeAll(rows);
  console.log('[tokens] Stored new FCM token. Total:', rows.length);
  return row;
}

export function removeToken(token) {
  const clean = String(token || '').trim();
  const rows = readAll();
  const next = rows.filter((row) => row.token !== clean);
  writeAll(next);
  console.log('[tokens] Removed token if present. Remaining:', next.length);
  return { removed: rows.length - next.length };
}

export function removeTokens(tokens) {
  const set = new Set((tokens || []).map((t) => String(t).trim()).filter(Boolean));
  if (!set.size) return { removed: 0 };
  const rows = readAll();
  const next = rows.filter((row) => !set.has(row.token));
  writeAll(next);
  const removed = rows.length - next.length;
  if (removed) console.log('[tokens] Removed expired/invalid tokens:', removed);
  return { removed };
}

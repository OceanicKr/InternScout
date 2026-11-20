// InternScout — Electron main process
// - Hosts a local API (port 4823) that the n8n workflows read the profile from
//   and push scored internship matches to.
// - Persists everything to a single JSON file in the app's user-data dir.
// - Proxies webhook calls to n8n from the renderer (avoids CORS entirely).

const { app, BrowserWindow, ipcMain, shell, Notification, dialog } = require('electron');
const express = require('express');
const path = require('path');
const fs = require('fs');

const APP_PORT = 4823;
let win = null;
let dataPath = null;

const DEFAULT_STATE = {
  profile: {
    name: '', email: '', location: '', education: '',
    skills: '', interests: '', links: '', resume: ''
  },
  settings: {
    n8nBase: 'http://localhost:5678',
    minScore: 50,
    requirePaid: true,
    requireGlobal: true,
    interestKeywords: 'AI, ML, machine learning, deep learning, computer vision, robotics, embedded systems',
    watchedCompanies: '',
    adzunaAppId: '',
    adzunaAppKey: '',
    adzunaCountries: 'in,gb,us,au,ca,sg,de,nl'
  },
  jobs: [] // { id, title, company, url, ..., analysis, status, tailored, application }
};

// ---------- store ----------
function loadState() {
  // First run: if no saved data yet, seed from the bundled profile (built from the user's resume).
  if (!fs.existsSync(dataPath)) {
    try {
      // seed-profile.json holds your real profile and is git-ignored;
      // fall back to the committed placeholder template.
      const own = path.join(__dirname, 'seed-profile.json');
      const seedFile = fs.existsSync(own) ? own : path.join(__dirname, 'seed-profile.example.json');
      const seed = JSON.parse(fs.readFileSync(seedFile, 'utf8'));
      return {
        profile: { ...DEFAULT_STATE.profile, ...(seed.profile || {}) },
        settings: { ...DEFAULT_STATE.settings, ...(seed.settings || {}) },
        jobs: []
      };
    } catch { /* fall through to defaults */ }
  }
  try {
    const raw = fs.readFileSync(dataPath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      profile: { ...DEFAULT_STATE.profile, ...(parsed.profile || {}) },
      settings: { ...DEFAULT_STATE.settings, ...(parsed.settings || {}) },
      jobs: Array.isArray(parsed.jobs) ? parsed.jobs : []
    };
  } catch {
    return JSON.parse(JSON.stringify(DEFAULT_STATE));
  }
}

function saveState(state) {
  fs.mkdirSync(path.dirname(dataPath), { recursive: true });
  fs.writeFileSync(dataPath, JSON.stringify(state, null, 2), 'utf8');
}

let state;

function notifyRenderer(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

// ---------- local API for n8n ----------
function startLocalServer() {
  const api = express();
  api.use(express.json({ limit: '4mb' }));

  api.get('/api/health', (_req, res) => res.json({ ok: true, app: 'InternScout' }));

  // n8n reads the live profile here
  api.get('/api/profile', (_req, res) => res.json(state.profile));

  // n8n reads scout config here (watched companies + optional board keys)
  api.get('/api/config', (_req, res) => {
    const s = state.settings || {};
    res.json({
      minScore: s.minScore ?? 50,
      requirePaid: s.requirePaid !== false,
      requireGlobal: s.requireGlobal !== false,
      interestKeywords: String(s.interestKeywords || ''),
      watchedCompanies: String(s.watchedCompanies || '')
        .split(/[\n,]/).map(x => x.trim()).filter(Boolean),
      adzuna: (s.adzunaAppId && s.adzunaAppKey) ? {
        appId: s.adzunaAppId,
        appKey: s.adzunaAppKey,
        countries: String(s.adzunaCountries || 'in,gb,us').split(',').map(x => x.trim()).filter(Boolean)
      } : {}
    });
  });

  // n8n pushes one scored job per request here
  api.post('/api/jobs', (req, res) => {
    const job = req.body;
    if (!job || !job.id || !job.title) {
      return res.status(400).json({ ok: false, error: 'Job needs at least id and title.' });
    }
    const existing = state.jobs.find(j => j.id === job.id);
    if (existing) {
      // refresh analysis but never clobber user progress
      existing.analysis = job.analysis || existing.analysis;
      existing.description = job.description || existing.description;
    } else {
      state.jobs.unshift({ ...job, status: job.status || 'new' });
      if (Notification.isSupported()) {
        new Notification({
          title: 'InternScout: new match',
          body: `${job.title} @ ${job.company} — score ${job.analysis?.score ?? '?'}`
        }).show();
      }
    }
    saveState(state);
    notifyRenderer('jobs:changed', state.jobs);
    res.json({ ok: true });
  });

  // Bind on 0.0.0.0 so a Dockerized n8n can reach the app via host.docker.internal.
  // (On a non-Docker setup this still works; Windows Firewall gates external access.)
  api.listen(APP_PORT, '0.0.0.0', () => {
    console.log(`InternScout local API on http://0.0.0.0:${APP_PORT} (reachable as host.docker.internal:${APP_PORT} from Docker)`);
  }).on('error', (err) => {
    dialog.showErrorBox('InternScout', `Could not bind port ${APP_PORT}: ${err.message}\nIs another copy of the app running?`);
  });
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('state:get', () => state);

  ipcMain.handle('profile:save', (_e, profile) => {
    state.profile = { ...state.profile, ...profile };
    saveState(state);
    return state.profile;
  });

  ipcMain.handle('settings:save', (_e, settings) => {
    state.settings = { ...state.settings, ...settings };
    saveState(state);
    return state.settings;
  });
  ipcMain.handle('job:update', (_e, { id, patch }) => {
    const job = state.jobs.find(j => j.id === id);
    if (!job) return null;
    Object.assign(job, patch);
    saveState(state);
    notifyRenderer('jobs:changed', state.jobs);
    return job;
  });

  ipcMain.handle('job:delete', (_e, id) => {
    state.jobs = state.jobs.filter(j => j.id !== id);
    saveState(state);
    return true;
  });

  ipcMain.handle('open:url', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Renderer -> main -> n8n webhook (no CORS issues, single timeout policy)
  ipcMain.handle('n8n:call', async (_e, { webhookPath, payload }) => {
    const base = (state.settings.n8nBase || 'http://localhost:5678').replace(/\/+$/, '');
    const url = `${base}/webhook/${webhookPath}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 240000);
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      const text = await res.text();
      let json;
      try { json = JSON.parse(text); } catch { json = { raw: text }; }
      if (!res.ok) return { ok: false, error: `n8n responded ${res.status}: ${text.slice(0, 300)}` };
      return { ok: true, data: json };
    } catch (err) {
      return { ok: false, error: `Could not reach n8n at ${url} — ${err.message}. Is n8n running and the workflow active?` };
    } finally {
      clearTimeout(timer);
    }
  });

  ipcMain.handle('export:text', async (_e, { suggestedName, content }) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win, {
      defaultPath: path.join(app.getPath('documents'), suggestedName)
    });
    if (canceled || !filePath) return null;
    fs.writeFileSync(filePath, content, 'utf8');
    return filePath;
  });
}

// ---------- window ----------
function createWindow() {
  win = new BrowserWindow({
    width: 1320,
    height: 880,
    minWidth: 980,
    minHeight: 640,
    backgroundColor: '#E9EDF0',
    title: 'InternScout',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(() => {
  dataPath = path.join(app.getPath('userData'), 'internscout-data.json');
  state = loadState();
  registerIpc();
  startLocalServer();
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

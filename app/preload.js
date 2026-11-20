const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('scout', {
  getState: () => ipcRenderer.invoke('state:get'),
  saveProfile: (profile) => ipcRenderer.invoke('profile:save', profile),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  updateJob: (id, patch) => ipcRenderer.invoke('job:update', { id, patch }),
  deleteJob: (id) => ipcRenderer.invoke('job:delete', id),
  openUrl: (url) => ipcRenderer.invoke('open:url', url),
  callN8n: (webhookPath, payload) => ipcRenderer.invoke('n8n:call', { webhookPath, payload }),
  exportText: (suggestedName, content) => ipcRenderer.invoke('export:text', { suggestedName, content }),
  onJobsChanged: (cb) => ipcRenderer.on('jobs:changed', (_e, jobs) => cb(jobs))
});

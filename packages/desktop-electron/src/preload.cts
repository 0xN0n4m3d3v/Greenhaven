const {contextBridge, ipcRenderer} = require('electron') as {
  contextBridge: {
    exposeInMainWorld(name: string, api: unknown): void;
  };
  ipcRenderer: {
    invoke(channel: string, ...args: unknown[]): Promise<unknown>;
  };
};

contextBridge.exposeInMainWorld('greenhavenDesktop', {
  platform: process.platform,
  filePicker: {
    selectDirectory: (options?: unknown) =>
      ipcRenderer.invoke('greenhaven:file-picker:select-directory', options),
  },
  diagnostics: {
    getPaths: () => ipcRenderer.invoke('greenhaven:diagnostics:get-paths'),
    startNetLog: () =>
      ipcRenderer.invoke('greenhaven:diagnostics:start-netlog'),
    stopNetLog: () => ipcRenderer.invoke('greenhaven:diagnostics:stop-netlog'),
  },
  config: {
    getDeepSeekKeyStatus: () =>
      ipcRenderer.invoke('greenhaven:config:get-deepseek-key-status'),
    saveDeepSeekApiKey: (apiKey: string) =>
      ipcRenderer.invoke('greenhaven:config:save-deepseek-api-key', apiKey),
  },
});

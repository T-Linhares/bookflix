import { contextBridge, ipcRenderer } from 'electron';

// The only things the web page may ask the desktop shell for. Each one is validated again in main.ts.
contextBridge.exposeInMainWorld('bookflix', {
  pickFolder: (current?: string): Promise<string | null> => ipcRenderer.invoke('pick-folder', current),
  openExternal: (url: string): Promise<boolean> => ipcRenderer.invoke('open-external', url),
  copyText: (text: string): Promise<void> => ipcRenderer.invoke('copy-text', text),
});

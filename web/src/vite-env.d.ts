/// <reference types="vite/client" />

/** Exposed by electron/preload.ts; undefined when the page runs in a plain browser (dev, `npm start`). */
interface BookflixBridge {
  /** Native folder dialog. Resolves to the chosen path, or null when cancelled. */
  pickFolder(current?: string): Promise<string | null>;
  /** Opens an https URL in the default browser (only allow-listed hosts are honoured). */
  openExternal(url: string): Promise<boolean>;
  /** Copies text to the clipboard. */
  copyText(text: string): Promise<void>;
}

interface Window {
  bookflix?: BookflixBridge;
}

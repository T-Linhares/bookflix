/** Where each API key is created. Ajustes links here, and the desktop app may open exactly these hosts (see isAllowedExternalUrl). */
export const KEY_PAGES = {
  googleBooks: 'https://console.cloud.google.com/apis/library/books.googleapis.com',
  gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  openai: 'https://platform.openai.com/api-keys',
} as const;

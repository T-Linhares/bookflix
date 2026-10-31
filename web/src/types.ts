export type Status = 'unread' | 'reading' | 'read' | 'abandoned';

export interface Book {
  id: number;
  path: string;
  filename: string;
  format: string;
  title: string | null;
  subtitle: string | null;
  authors: string;
  series: string | null;
  series_index: number | null;
  publisher: string | null;
  year: number | null;
  isbn: string | null;
  language: string | null;
  description?: string | null;
  tags: string[];
  pages: number | null;
  cover: string | null;
  status: Status;
  progress: number;
  rating: number | null;
  review?: string | null;
  added_at: number;
  last_read: number | null;
  finished_at: number | null;
  read_time: number;
  organized: number;
  sent_to_kindle: number;
  sources: Record<string, string>;
  notes_count?: number;
  series_count?: number;
  series_read?: number;
}

export interface Highlight {
  id: number;
  book_id: number;
  kind: 'highlight' | 'note';
  text: string | null;
  note: string | null;
  chapter: string | null;
  page: string | null;
  color: string | null;
  created_at: string | null;
  source: 'kindle' | 'user';
  edited: number;
}

export interface BookDetail extends Book {
  highlights: Highlight[];
  days: { day: string; seconds: number; pages: number }[];
}

export interface Meta {
  title?: string;
  subtitle?: string;
  authors: string[];
  series?: string;
  seriesIndex?: number;
  publisher?: string;
  year?: number;
  isbn?: string;
  language?: string;
  description?: string;
  tags: string[];
  pages?: number;
}

export interface Staging {
  id: number;
  original_name: string;
  format: string;
  source: 'upload' | 'inbox' | 'library';
  book_id: number | null;
  meta: Meta;
  sources: Record<string, string>;
  cover: string | null;
}

export interface Settings {
  booksDir: string;
  inboxDir: string;
  nameTemplate: string;
  useFolders: boolean;
  moveOriginals: boolean;
  yearlyGoal: number;
  anthropicKey: string;
  geminiKey: string;
  openaiKey: string;
  aiOrder: 'auto' | 'gemini' | 'anthropic' | 'openai';
  googleBooksKey: string;
  checkUpdates: boolean;
  /** false when the OS gave the app no secure store, so keys sit in plain text locally */
  secretsEncrypted: boolean;
}

export interface Rec {
  key: string;
  title: string;
  authors: string[];
  description?: string;
  coverUrl?: string;
  link?: string;
  year?: number;
  reason: string;
  wishlisted?: boolean;
}

export const STATUS_LABEL: Record<Status, string> = {
  unread: 'Não lido',
  reading: 'Lendo',
  read: 'Lido',
  abandoned: 'Em pausa',
};

export const SOURCE_LABEL: Record<string, string> = {
  google: 'Google Books',
  openlibrary: 'Open Library',
  embedded: 'No arquivo',
  filename: 'Nome do arquivo',
  livro: 'Texto do livro',
  brasilapi: 'BrasilAPI',
  gerado: 'Gerado',
  manual: 'Manual',
};

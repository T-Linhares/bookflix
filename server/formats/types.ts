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

export interface Cover {
  data: Buffer;
  ext: 'jpg' | 'png' | 'gif' | 'webp';
}

export const emptyMeta = (): Meta => ({ authors: [], tags: [] });

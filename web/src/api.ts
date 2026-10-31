export class ApiError extends Error {
  status: number;
  code?: string;
  constructor(message: string, status: number, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api<T = any>(url: string, opts: { method?: string; body?: unknown; form?: FormData } = {}): Promise<T> {
  const res = await fetch(url, {
    method: opts.method ?? (opts.body || opts.form ? 'POST' : 'GET'),
    headers: opts.body ? { 'content-type': 'application/json' } : undefined,
    body: opts.form ?? (opts.body ? JSON.stringify(opts.body) : undefined),
  });
  const text = await res.text();
  let data: any = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }
  if (!res.ok) throw new ApiError(data?.error ?? `Erro ${res.status}`, res.status, data?.code);
  return data as T;
}

export interface KindleSendResult {
  root: string;
  dest: string;
  copied: string[];
  already: string[];
  conflicts: string[];
  failed: { id: number; title: string; reason: string }[];
}

/** Copies books to documents/Livros on the plugged-in Kindle (auto-detected unless `path` is given). */
export const sendToKindle = (body: { bookIds?: number[]; allReady?: boolean; path?: string }) => api<KindleSendResult>('/api/kindle/send', { body });

export function describeSend(r: KindleSendResult): { text: string; kind: 'ok' | 'err' } {
  const parts: string[] = [];
  if (r.copied.length) parts.push(`${r.copied.length} enviado${r.copied.length > 1 ? 's' : ''}`);
  if (r.already.length) parts.push(`${r.already.length} já estava${r.already.length > 1 ? 'm' : ''} no Kindle`);
  if (r.conflicts.length) parts.push(`${r.conflicts.length} com mesmo nome e tamanho diferente (não substituído)`);
  if (r.failed.length) parts.push(`${r.failed.length} com erro: ${r.failed.map((f) => `${f.title} (${f.reason})`).join('; ')}`);
  const bad = r.conflicts.length > 0 || r.failed.length > 0;
  return { text: `${parts.join(', ') || 'Nada para enviar'} → ${r.dest}`, kind: bad ? 'err' : 'ok' };
}

export const coverSrc = (b: { cover?: string | null }) => (b.cover ? `/covers/${b.cover}` : null);

export function qs(params: Record<string, string | number | boolean | string[] | undefined | null>) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '' || (Array.isArray(v) && !v.length)) continue;
    sp.set(k, Array.isArray(v) ? v.join(',') : String(v));
  }
  return sp.toString();
}

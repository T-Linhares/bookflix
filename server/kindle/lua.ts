import luaparse from 'luaparse';

/** Minimal evaluator for the `return { ... }` data tables KOReader writes (no code execution). */
function evalNode(n: any): any {
  switch (n.type) {
    case 'StringLiteral':
      return n.value ?? unquote(n.raw);
    case 'NumericLiteral':
    case 'BooleanLiteral':
      return n.value;
    case 'NilLiteral':
      return null;
    case 'UnaryExpression':
      if (n.operator === '-') return -evalNode(n.argument);
      return null;
    case 'TableConstructorExpression': {
      const obj: Record<string, any> = {};
      let auto = 1;
      for (const f of n.fields) {
        if (f.type === 'TableValue') obj[auto++] = evalNode(f.value);
        else if (f.type === 'TableKeyString') obj[f.key.name] = evalNode(f.value);
        else if (f.type === 'TableKey') obj[String(evalNode(f.key))] = evalNode(f.value);
      }
      return obj;
    }
    default:
      return null;
  }
}

const unquote = (raw: string) => raw.replace(/^(["'])([\s\S]*)\1$/, '$2').replace(/\\(["'\\])/g, '$1').replace(/\\n/g, '\n');

export function parseLuaTable(src: string): Record<string, any> {
  const ast: any = luaparse.parse(src, { luaVersion: '5.3' });
  const ret = ast.body.find((s: any) => s.type === 'ReturnStatement');
  if (!ret?.arguments?.[0]) throw new Error('Arquivo Lua sem "return { ... }"');
  return evalNode(ret.arguments[0]);
}

/** Lua tables become objects with numeric keys; this restores their order as an array. */
export function toList<T = any>(v: unknown): T[] {
  if (!v) return [];
  if (Array.isArray(v)) return v as T[];
  if (typeof v !== 'object') return [];
  return Object.keys(v as object)
    .sort((a, b) => Number(a) - Number(b))
    .map((k) => (v as any)[k]);
}

export interface Annotation {
  /** key of this annotation in the file's table, needed to edit it in place */
  key?: string;
  kind: 'highlight' | 'note';
  text: string;
  note: string | null;
  chapter: string | null;
  page: string | null;
  color: string | null;
  datetime: string | null;
}

export interface Sidecar {
  partialMd5?: string;
  percent: number;
  docPages?: number;
  props: { title?: string; authors?: string; series?: string; language?: string };
  status?: 'reading' | 'complete' | 'abandoned';
  rating?: number;
  review?: string;
  modified?: string;
  annotations: Annotation[];
}

export function parseSidecar(src: string): Sidecar {
  const t = parseLuaTable(src);
  const annotations: Annotation[] = [];

  const entries = t.annotations && typeof t.annotations === 'object' ? Object.entries<any>(t.annotations).sort(([x], [y]) => Number(x) - Number(y)) : [];
  for (const [key, a] of entries) {
    const text = (a.text ?? '').toString().trim();
    const note = a.note ? String(a.note).trim() : null;
    if (!a.drawer && !note) continue; // plain bookmark
    if (!text && !note) continue;
    annotations.push({
      key,
      kind: note ? 'note' : 'highlight',
      text,
      note,
      chapter: a.chapter ?? null,
      page: a.pageno != null ? String(a.pageno) : a.page != null && typeof a.page !== 'object' ? String(a.page) : null,
      color: a.color ?? null,
      datetime: a.datetime ?? null,
    });
  }

  // KOReader < 2023.04 stored highlights per page under "highlight"
  if (!annotations.length && t.highlight) {
    for (const [page, list] of Object.entries<any>(t.highlight)) {
      for (const h of toList<any>(list)) {
        const text = (h.text ?? '').toString().trim();
        if (!text) continue;
        annotations.push({
          kind: h.notes ? 'note' : 'highlight',
          text,
          note: h.notes && h.notes !== h.text ? String(h.notes) : null,
          chapter: h.chapter ?? null,
          page: /^\d+$/.test(page) ? page : null,
          color: h.color ?? null,
          datetime: h.datetime ?? null,
        });
      }
    }
  }

  const s = t.summary ?? {};
  return {
    partialMd5: t.partial_md5_checksum,
    percent: Number(t.percent_finished) || 0,
    docPages: t.doc_pages ? Number(t.doc_pages) : undefined,
    props: {
      title: t.doc_props?.title ?? t.stats?.title,
      authors: t.doc_props?.authors ?? t.stats?.authors,
      series: t.doc_props?.series,
      language: t.doc_props?.language ?? t.stats?.language,
    },
    status: s.status,
    rating: s.rating ? Number(s.rating) : undefined,
    review: s.note ? String(s.note) : undefined,
    modified: s.modified,
    annotations,
  };
}

const LUA_ESCAPES: Record<string, string> = { '\\': '\\\\', '"': '\\"', '\n': '\\n' };

/** A Lua string literal; control characters other than newline become decimal escapes (\ddd). */
const luaString = (s: string) =>
  '"' +
  s.replace(/\r\n?/g, '\n').replace(/[\\"\x00-\x1f]/g, (c) => LUA_ESCAPES[c] ?? '\\' + c.charCodeAt(0).toString().padStart(3, '0')) +
  '"';

/** Sets `key` in the table reached by following `path` from the root. Only that value changes: the file is edited in place by position, never re-serialised. */
function setField(src: string, path: (string | number)[], key: string, literal: string): string {
  const ast: any = luaparse.parse(src, { luaVersion: '5.3', ranges: true });
  const root = ast.body.find((s: any) => s.type === 'ReturnStatement')?.arguments?.[0];
  if (root?.type !== 'TableConstructorExpression') throw new Error('Arquivo Lua sem "return { ... }"');

  /** Same key rules as evalNode: names, ["strings"], [numbers] and positional values. */
  const find = (table: any, wanted: string | number) => {
    let auto = 1;
    for (const f of table.fields) {
      const k = f.type === 'TableValue' ? auto++ : f.type === 'TableKeyString' ? f.key.name : f.key.type === 'StringLiteral' ? (f.key.value ?? unquote(f.key.raw)) : f.key.value;
      if (String(k) === String(wanted)) return f;
    }
    return undefined;
  };
  const insertInto = (table: any, text: string) => src.slice(0, table.range[0] + 1) + `\n    ${text}` + src.slice(table.range[0] + 1);

  let table = root;
  for (const step of path) {
    const f = find(table, step);
    if (!f) {
      if (table === root && step === 'summary') return insertInto(root, `["summary"] = { ["${key}"] = ${literal} },`);
      throw new Error(`"${step}" não existe neste arquivo`);
    }
    if (f.value.type !== 'TableConstructorExpression') throw new Error(`"${step}" não é uma tabela`);
    table = f.value;
  }
  const field = find(table, key);
  if (field) return src.slice(0, field.value.range[0]) + literal + src.slice(field.value.range[1]);
  return insertInto(table, `["${key}"] = ${literal},`);
}

/** KOReader's "Resenha" field. */
export const setSummaryNote = (src: string, note: string) => setField(src, ['summary'], 'note', luaString(note));
export const setSummaryRating = (src: string, stars: number) => setField(src, ['summary'], 'rating', String(stars));
export const setSummaryStatus = (src: string, status: 'reading' | 'complete' | 'abandoned') => setField(src, ['summary'], 'status', luaString(status));
/** The note attached to one highlight; `key` is the annotation's key in the file (see Annotation.key). */
export const setAnnotationNote = (src: string, key: string, note: string) => setField(src, ['annotations', key], 'note', luaString(note));

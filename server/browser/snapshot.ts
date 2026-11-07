// Fotografia de uma página para o modelo: a árvore de acessibilidade do Playwright (`ariaSnapshotJSON({mode: 'ai'})`,
// que já atravessa shadow DOM e iframes e marca cada elemento com uma ref do tipo `e7`/`f1e3`) virada num texto
// compacto, com refs só nos elementos em que dá para agir. As refs que o modelo vê levam a revisão da aba
// (`r3-e7`): a ação confere a revisão e recusa ref velha ("faça `ler` de novo"). Puro: sem Playwright aqui.

/** Elementos com ref por fotografia (o resto aparece sem ref). */
export const MAX_ELEMENTS = 200;
/** Tamanho máximo do texto da página. */
export const MAX_TEXT = 20_000;
/** Texto de um nó (nome, valor) no máximo com isto. */
const NODE_TEXT_MAX = 300;

/** Papéis em que se clica ou digita: só eles ganham ref. */
const ACTIONABLE = new Set([
  'button',
  'link',
  'textbox',
  'searchbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'option',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'tab',
  'switch',
  'slider',
  'spinbutton',
  'treeitem',
  'gridcell',
]);
/** Papéis onde se digita (o `digitar` só aceita estes). */
export const TYPABLE = new Set(['textbox', 'searchbox', 'combobox', 'spinbutton']);

const STATES = ['checked', 'disabled', 'expanded', 'pressed', 'selected', 'level', 'active'] as const;

export interface AriaNode {
  role?: string;
  name?: string;
  ref?: string;
  text?: string;
  url?: string;
  cursor?: string;
  box?: { x: number; y: number; width: number; height: number };
  children?: Array<AriaNode | string>;
  [state: string]: unknown;
}

/** Um elemento com ref na fotografia atual. */
export interface ElementInfo {
  /** Ref do Playwright (`e7`, `f1e3`): o que vai para `page.getByRef`. */
  raw: string;
  role: string;
  name: string;
}

export interface PageSnapshot {
  text: string;
  elements: Map<string, ElementInfo>;
  /** Cortou texto ou elementos. */
  truncated: boolean;
  /** Em quantas partes (`ler` com `parte`) a página inteira cabe, na ordem da página. 1 = cabe numa leitura. */
  parts: number;
  /** A parte devolvida (só com `part`). */
  part?: number;
}

/** Ref que o modelo vê: a revisão + a ref do Playwright. */
export function publicRef(revision: number, raw: string): string {
  return `r${revision}-${raw}`;
}

/** `r3-e7` → {revision: 3, raw: 'e7'}; undefined se não tem esse formato. */
export function parseRef(ref: string): { revision: number; raw: string } | undefined {
  const m = /^r(\d{1,9})-((?:f\d{1,6})?e\d{1,7})$/.exec(ref.trim());
  return m ? { revision: Number(m[1]), raw: m[2] } : undefined;
}

function clip(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

function q(s: string): string {
  return JSON.stringify(clip(s, NODE_TEXT_MAX));
}

function isNode(v: unknown): v is AriaNode {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function actionable(n: AriaNode): boolean {
  return !!n.ref && (ACTIONABLE.has(n.role ?? '') || n.cursor === 'pointer');
}

/** Nó que não diz nada sozinho (generic/none sem nome nem texto nem ação): os filhos sobem um nível. */
function transparent(n: AriaNode): boolean {
  return (n.role === 'generic' || n.role === 'none' || n.role === 'presentation' || !n.role) && !n.name && !n.text && !actionable(n);
}

interface Viewport {
  width: number;
  height: number;
}

function intersects(n: AriaNode, vp: Viewport): boolean {
  const b = n.box;
  if (!b) return false;
  return b.width > 0 && b.height > 0 && b.x < vp.width && b.y < vp.height && b.x + b.width > 0 && b.y + b.height > 0;
}

class Writer {
  lines: string[] = [];
  /** Refs criadas em cada linha (mesma posição de `lines`), para dividir em partes. */
  lineRefs: Array<Array<[string, ElementInfo]>> = [];
  size = 0;
  full = false;
  truncated = false;
  readonly elements = new Map<string, ElementInfo>();
  private pending: Array<[string, ElementInfo]> = [];
  constructor(
    private readonly revision: number,
    private readonly maxText: number,
    private readonly maxElements: number,
  ) {}

  line(depth: number, s: string): boolean {
    if (this.full) return false;
    const l = `${'  '.repeat(Math.min(depth, 12))}${s}`;
    if (this.size + l.length + 1 > this.maxText) {
      this.full = true;
      this.truncated = true;
      return false;
    }
    this.lines.push(l);
    this.lineRefs.push(this.pending);
    this.pending = [];
    this.size += l.length + 1;
    return true;
  }

  node(n: AriaNode): string {
    let s = `- ${n.role ?? 'generic'}`;
    if (n.name) s += ` ${q(n.name)}`;
    for (const k of STATES) {
      const v = n[k];
      if (v === true) s += ` [${k}]`;
      else if (typeof v === 'number' || (typeof v === 'string' && v)) s += ` [${k}=${String(v)}]`;
    }
    if (actionable(n) && n.ref) {
      if (this.elements.size < this.maxElements) {
        const ref = publicRef(this.revision, n.ref);
        const info = { raw: n.ref, role: n.role ?? 'generic', name: clip(n.name ?? n.text ?? '', NODE_TEXT_MAX) };
        this.elements.set(ref, info);
        this.pending.push([ref, info]);
        s += ` [ref=${ref}]`;
      } else this.truncated = true;
    }
    if (n.url && n.role === 'link') s += ` → ${clip(n.url, 200)}`;
    if (n.text) s += `: ${clip(n.text, NODE_TEXT_MAX)}`;
    return s;
  }
}

/** Escreve a subárvore; `keep` decide se um nó (com a subárvore dele) entra. */
function walk(w: Writer, items: Array<AriaNode | string> | undefined, depth: number, keep: (n: AriaNode) => boolean): void {
  for (const item of items ?? []) {
    if (w.full) return;
    if (typeof item === 'string') {
      const t = clip(item, NODE_TEXT_MAX);
      if (t) w.line(depth, `- text: ${t}`);
      continue;
    }
    if (!isNode(item) || !keep(item)) continue;
    if (transparent(item)) {
      walk(w, item.children, depth, keep);
      continue;
    }
    w.line(depth, w.node(item));
    walk(w, item.children, depth + 1, keep);
  }
}

/** Tem algo (ele ou um descendente) dentro da tela. */
function anyInView(n: AriaNode, vp: Viewport, memo: Map<AriaNode, boolean>): boolean {
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  const r = intersects(n, vp) || (n.children ?? []).some((c) => isNode(c) && anyInView(c, vp, memo));
  memo.set(n, r);
  return r;
}

/** Tudo (ele e os descendentes) dentro da tela? Nó sem caixa não conta. */
function allInView(n: AriaNode, vp: Viewport, memo: Map<AriaNode, boolean>): boolean {
  const hit = memo.get(n);
  if (hit !== undefined) return hit;
  const r = (!n.box || intersects(n, vp)) && (n.children ?? []).every((c) => !isNode(c) || allInView(c, vp, memo));
  memo.set(n, r);
  return r;
}

/** Divide a página inteira (na ordem) em partes de até `maxText` caracteres e `maxElements` refs. */
function splitParts(w: Writer, maxText: number, maxElements: number): Array<{ lines: string[]; refs: Array<[string, ElementInfo]> }> {
  const parts: Array<{ lines: string[]; refs: Array<[string, ElementInfo]> }> = [];
  let cur = { lines: [] as string[], refs: [] as Array<[string, ElementInfo]> };
  let size = 0;
  w.lines.forEach((line, i) => {
    const refs = w.lineRefs[i] ?? [];
    if (cur.lines.length && (size + line.length + 1 > maxText || cur.refs.length + refs.length > maxElements)) {
      parts.push(cur);
      cur = { lines: [], refs: [] };
      size = 0;
    }
    cur.lines.push(line);
    cur.refs.push(...refs);
    size += line.length + 1;
  });
  if (cur.lines.length || !parts.length) parts.push(cur);
  return parts;
}

/**
 * Texto da página a partir da árvore. Se tudo cabe, vai na ordem da página. Se não cabe, primeiro o que está na tela
 * (pela caixa de cada nó, `boxes: true`), depois o resto até o limite; `parts` diz em quantas partes a página inteira
 * cabe. Com `part` (1, 2, ...), devolve só aquele pedaço da página inteira, na ordem (para páginas longas).
 */
export function renderSnapshot(
  tree: unknown,
  revision: number,
  viewport: Viewport | null,
  limits: { maxText?: number; maxElements?: number; part?: number } = {},
): PageSnapshot {
  const roots = (Array.isArray(tree) ? tree : [tree]).filter((x): x is AriaNode | string => typeof x === 'string' || isNode(x));
  const maxText = limits.maxText ?? MAX_TEXT;
  const maxElements = limits.maxElements ?? MAX_ELEMENTS;
  // A página inteira, sem limite (a árvore já vem com os textos cortados por nó).
  const whole = new Writer(revision, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
  walk(whole, roots, 0, () => true);
  const fits = whole.size <= maxText && whole.elements.size <= maxElements;
  if (fits) return { text: whole.lines.join('\n'), elements: whole.elements, truncated: false, parts: 1, ...(limits.part ? { part: 1 } : {}) };
  const parts = splitParts(whole, maxText, maxElements);
  if (limits.part !== undefined) {
    const k = Math.min(Math.max(1, Math.floor(limits.part)), parts.length);
    const chosen = parts[k - 1];
    return { text: chosen.lines.join('\n'), elements: new Map(chosen.refs), truncated: true, parts: parts.length, part: k };
  }
  if (!viewport) {
    const first = parts[0];
    return { text: first.lines.join('\n'), elements: new Map(first.refs), truncated: true, parts: parts.length };
  }
  const w = new Writer(revision, maxText, maxElements);
  const some = new Map<AriaNode, boolean>();
  const all = new Map<AriaNode, boolean>();
  w.line(0, '# na tela');
  walk(w, roots, 0, (n) => anyInView(n, viewport, some));
  w.line(0, '# fora da tela');
  walk(w, roots, 0, (n) => !allInView(n, viewport, all));
  return { text: w.lines.join('\n'), elements: w.elements, truncated: true, parts: parts.length };
}

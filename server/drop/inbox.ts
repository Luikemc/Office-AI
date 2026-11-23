// Pasta `entrada` de cada projeto com um agente aberto. Um arquivo novo ali avisa só as sessões daquela pasta
// (a mesma fila de POST /api/messages). Arquivo que já estava na pasta quando a sessão abriu não avisa.
import { mkdirSync, readdirSync, realpathSync, statSync, watch, type FSWatcher } from 'node:fs';
import { join } from 'node:path';
import { tr } from '../../shared/i18n';
import { errMsg, log } from '../log';

/** Nome da pasta de entrada, dentro da pasta do projeto. */
export const INBOX_NAME = 'entrada';
/** Espera entre a mudança e a leitura, e de novo até o tamanho do arquivo parar de crescer. */
export const DROP_QUIET_MS = 500;
/** Sem sessão pronta para receber: tenta de novo depois deste tempo, sem avisar a cada volta. */
export const DROP_RETRY_MS = 5_000;
const NOTICE_MAX = 20;

export interface DirEntry {
  name: string;
  size: number;
}

export interface DropTarget {
  id: string;
  kind: string;
  status: string;
  roomId: string;
}

/** A sala e a pasta observada são o mesmo diretório (resolve atalho). */
export function sameProjectPath(room: string, folder: string): boolean {
  try {
    return realpathSync(room) === folder;
  } catch {
    return room === folder;
  }
}

/** Agentes principais presentes cuja sala é `folder` (caminho já resolvido). */
export function sessionsForFolder(
  agents: readonly DropTarget[],
  roomPath: (roomId: string) => string | undefined,
  folder: string,
  samePath: (room: string, folder: string) => boolean = (a, b) => a === b,
): string[] {
  const ids: string[] = [];
  for (const a of agents) {
    if (a.kind !== 'main' || a.status === 'offline') continue;
    const room = roomPath(a.roomId);
    if (room && samePath(room, folder)) ids.push(a.id);
  }
  return ids;
}

/** Nome que dá para citar na mensagem (o agente abre o arquivo por ele). */
function citeable(name: string): boolean {
  return !!name && !name.startsWith('.') && name.length <= 180 && !/[\u0000-\u001f]/.test(name);
}

/**
 * Arquivos que ainda não foram avisados e cujo tamanho repetiu desde a leitura anterior.
 * Tamanho novo fica de espera (a cópia pode não ter terminado).
 */
export function stableNewFiles(
  known: ReadonlySet<string>,
  seenSizes: ReadonlyMap<string, number>,
  current: readonly DirEntry[],
): { announce: string[]; sizes: Map<string, number>; waiting: boolean } {
  const sizes = new Map<string, number>();
  const announce: string[] = [];
  let waiting = false;
  for (const f of current) {
    if (!citeable(f.name)) continue;
    sizes.set(f.name, f.size);
    if (known.has(f.name)) continue;
    if (seenSizes.get(f.name) === f.size) announce.push(f.name);
    else waiting = true;
  }
  announce.sort();
  return { announce, sizes, waiting };
}

/** Frase que a sessão recebe. Um arquivo cita o nome; vários, a lista. */
export function dropNotice(names: readonly string[]): string {
  const shown = names.slice(0, NOTICE_MAX);
  const extra = names.length - shown.length;
  if (names.length === 1) return tr('Chegou {0} na pasta.', [names[0]]);
  if (extra > 0) return tr('Chegaram na pasta: {0} e mais {1}.', [shown.join(', '), extra]);
  return tr('Chegaram na pasta: {0}.', [shown.join(', ')]);
}

interface Slot {
  /** Pasta do projeto, caminho resolvido. É ela que casa com a sala. */
  project: string;
  inbox: string;
  known: Set<string>;
  sizes: Map<string, number>;
  watcher: FSWatcher;
}

export interface InboxWatchOptions {
  /** Pastas de projeto com agente aberto agora. */
  folders: () => string[];
  /**
   * Avisa as sessões da pasta. Devolve false se nenhuma recebeu (a sessão ainda não busca a caixa):
   * o arquivo continua pendente e a leitura tenta de novo.
   */
  notify: (project: string, names: string[]) => boolean;
  quietMs?: number;
  retryMs?: number;
  /** Cria `entrada` e devolve o caminho resolvido dela, ou undefined se não der. */
  ensureDir?: (project: string) => { project: string; inbox: string } | undefined;
  readDir?: (inbox: string) => DirEntry[];
  watchDir?: (inbox: string, onEvent: () => void) => FSWatcher;
}

/** Garante `entrada` dentro do projeto e recusa atalho que saia dele. */
export function ensureInbox(project: string): { project: string; inbox: string } | undefined {
  try {
    const root = realpathSync(project);
    const inbox = join(root, INBOX_NAME);
    mkdirSync(inbox, { recursive: true });
    const real = realpathSync(inbox);
    if (real !== join(root, INBOX_NAME)) return undefined;
    return { project: root, inbox: real };
  } catch (err) {
    log.warnOnce(`drop:${project}`, tr('Não deu para preparar a pasta entrada em {0} ({1}).', [project, errMsg(err)]));
    return undefined;
  }
}

function readInbox(inbox: string): DirEntry[] {
  const out: DirEntry[] = [];
  for (const name of readdirSync(inbox)) {
    try {
      const st = statSync(join(inbox, name));
      if (st.isFile()) out.push({ name, size: st.size });
    } catch {
      // sumiu no meio da leitura
    }
  }
  return out;
}

/**
 * Uma observação por pasta de projeto. Arquivos que já estavam em `entrada` ficam conhecidos e não acordam ninguém.
 */
export class InboxWatch {
  private slots = new Map<string, Slot>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly quietMs: number;
  private readonly retryMs: number;
  private readonly ensure: NonNullable<InboxWatchOptions['ensureDir']>;
  private readonly read: NonNullable<InboxWatchOptions['readDir']>;
  private readonly open: NonNullable<InboxWatchOptions['watchDir']>;

  constructor(private readonly opts: InboxWatchOptions) {
    this.quietMs = opts.quietMs ?? DROP_QUIET_MS;
    this.retryMs = opts.retryMs ?? DROP_RETRY_MS;
    this.ensure = opts.ensureDir ?? ensureInbox;
    this.read = opts.readDir ?? readInbox;
    this.open =
      opts.watchDir ??
      ((dir, onEvent) => {
        const w = watch(dir, { persistent: false }, onEvent);
        w.on('error', () => {
          w.close();
          this.disarm(dir);
        });
        return w;
      });
  }

  /** Abre e fecha observações conforme as salas abertas. */
  sync(): void {
    const wanted = new Set<string>();
    for (const folder of this.opts.folders()) {
      const made = this.ensure(folder);
      if (!made) continue;
      wanted.add(made.inbox);
      if (!this.slots.has(made.inbox)) this.arm(made.project, made.inbox);
    }
    for (const inbox of [...this.slots.keys()]) if (!wanted.has(inbox)) this.disarm(inbox);
  }

  stop(): void {
    for (const inbox of [...this.slots.keys()]) this.disarm(inbox);
  }

  private arm(project: string, inbox: string): void {
    const known = new Set<string>();
    try {
      for (const f of this.read(inbox)) if (citeable(f.name)) known.add(f.name);
    } catch {
      // pasta acabou de ser criada: começa vazia
    }
    let watcher: FSWatcher;
    try {
      watcher = this.open(inbox, () => this.schedule(inbox, this.quietMs));
    } catch (err) {
      log.warnOnce(`drop-watch:${inbox}`, tr('Não deu para observar {0} ({1}).', [inbox, errMsg(err)]));
      return;
    }
    this.slots.set(inbox, { project, inbox, known, sizes: new Map(), watcher });
    log.info(tr('Arquivos novos em {0} avisam só a sessão dessa pasta.', [inbox]));
  }

  private disarm(inbox: string): void {
    const t = this.timers.get(inbox);
    if (t) clearTimeout(t);
    this.timers.delete(inbox);
    const slot = this.slots.get(inbox);
    this.slots.delete(inbox);
    slot?.watcher.close();
  }

  private schedule(inbox: string, ms: number): void {
    const prev = this.timers.get(inbox);
    if (prev) clearTimeout(prev);
    const t = setTimeout(() => {
      this.timers.delete(inbox);
      this.scan(inbox);
    }, ms);
    t.unref?.();
    this.timers.set(inbox, t);
  }

  private scan(inbox: string): void {
    const slot = this.slots.get(inbox);
    if (!slot) return;
    let current: DirEntry[];
    try {
      current = this.read(inbox);
    } catch {
      return;
    }
    const { announce, sizes, waiting } = stableNewFiles(slot.known, slot.sizes, current);
    slot.sizes = sizes;
    for (const name of [...slot.known]) if (!sizes.has(name)) slot.known.delete(name);
    let retry = false;
    if (announce.length) {
      let accepted = false;
      try {
        accepted = this.opts.notify(slot.project, announce);
      } catch (err) {
        log.warnOnce(`drop-send:${inbox}`, tr('Não deu para avisar a sessão sobre arquivo novo em {0} ({1}).', [inbox, errMsg(err)]));
      }
      if (accepted) for (const name of announce) slot.known.add(name);
      else retry = true;
    }
    if (waiting) this.schedule(inbox, this.quietMs);
    else if (retry) this.schedule(inbox, this.retryMs);
  }
}

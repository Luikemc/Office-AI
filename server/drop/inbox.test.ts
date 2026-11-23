// Pasta entrada: quem é avisado, quando um arquivo conta como novo, e a observação em si (relógio e watch de mentira).
import { describe, expect, it, vi } from 'vitest';
import type { FSWatcher } from 'node:fs';
import { dropNotice, InboxWatch, sessionsForFolder, stableNewFiles, type DirEntry } from './inbox';

const agents = [
  { id: 'x', kind: 'main', status: 'idle', roomId: 'room-x' },
  { id: 'x2', kind: 'main', status: 'working', roomId: 'room-x' },
  { id: 'y', kind: 'main', status: 'idle', roomId: 'room-y' },
  { id: 'off', kind: 'main', status: 'offline', roomId: 'room-x' },
  { id: 'sub', kind: 'sub', status: 'working', roomId: 'room-x' },
];

const room = (id: string) => (id === 'room-x' ? '/proj/x' : id === 'room-y' ? '/proj/y' : undefined);

describe('sessões da pasta', () => {
  it('avisa só os principais presentes daquela pasta', () => {
    expect(sessionsForFolder(agents, room, '/proj/x')).toEqual(['x', 'x2']);
    expect(sessionsForFolder(agents, room, '/proj/y')).toEqual(['y']);
    expect(sessionsForFolder(agents, room, '/proj/z')).toEqual([]);
  });
});

describe('arquivo estável', () => {
  it('espera o tamanho repetir e não avisa o que já foi dito', () => {
    const first = stableNewFiles(new Set(), new Map(), [{ name: 'a.pdf', size: 10 }]);
    expect(first.announce).toEqual([]);
    expect(first.waiting).toBe(true);
    const second = stableNewFiles(new Set(), first.sizes, [{ name: 'a.pdf', size: 10 }]);
    expect(second.announce).toEqual(['a.pdf']);
    expect(second.waiting).toBe(false);
    const again = stableNewFiles(new Set(['a.pdf']), second.sizes, [{ name: 'a.pdf', size: 10 }]);
    expect(again.announce).toEqual([]);
  });

  it('tamanho que ainda cresce continua de espera', () => {
    const seen = new Map([['a.pdf', 10]]);
    const next = stableNewFiles(new Set(), seen, [{ name: 'a.pdf', size: 40 }]);
    expect(next.announce).toEqual([]);
    expect(next.waiting).toBe(true);
  });

  it('ignora oculto e nome com quebra de linha', () => {
    const cur: DirEntry[] = [
      { name: '.oculto', size: 1 },
      { name: 'ruim\n', size: 1 },
    ];
    const once = stableNewFiles(new Set(), new Map([['.oculto', 1], ['ruim\n', 1]]), cur);
    expect(once.announce).toEqual([]);
    expect(once.waiting).toBe(false);
  });
});

describe('texto do aviso', () => {
  it('um arquivo cita o nome; vários, a lista', () => {
    expect(dropNotice(['contrato.pdf'])).toBe('Chegou contrato.pdf na pasta.');
    expect(dropNotice(['a.pdf', 'b.png'])).toBe('Chegaram na pasta: a.pdf, b.png.');
  });
});

describe('observação', () => {
  it('arquivo novo na pasta x avisa x e o que já estava lá não avisa', () => {
    vi.useFakeTimers();
    const files = new Map<string, DirEntry[]>([['/proj/x/entrada', [{ name: 'velho.txt', size: 3 }]]]);
    const events = new Map<string, () => void>();
    const notices: { folder: string; names: string[] }[] = [];
    const watch = new InboxWatch({
      folders: () => ['/proj/x', '/proj/y'],
      notify: (folder, names) => {
        notices.push({ folder, names });
        return true;
      },
      quietMs: 500,
      retryMs: 5_000,
      ensureDir: (project) => ({ project, inbox: `${project}/entrada` }),
      readDir: (inbox) => files.get(inbox) ?? [],
      watchDir: (inbox, onEvent) => {
        events.set(inbox, onEvent);
        return { close: () => void events.delete(inbox), on: () => {} } as unknown as FSWatcher;
      },
    });
    watch.sync();
    events.get('/proj/x/entrada')!();
    vi.advanceTimersByTime(500);
    expect(notices).toEqual([]);
    files.set('/proj/x/entrada', [
      { name: 'velho.txt', size: 3 },
      { name: 'contrato.pdf', size: 20 },
    ]);
    events.get('/proj/x/entrada')!();
    vi.advanceTimersByTime(500);
    expect(notices).toEqual([]);
    vi.advanceTimersByTime(500);
    expect(notices).toEqual([{ folder: '/proj/x', names: ['contrato.pdf'] }]);
    watch.stop();
    vi.useRealTimers();
  });

  it('sem sessão pronta, tenta de novo e então avisa', () => {
    vi.useFakeTimers();
    const files = new Map<string, DirEntry[]>([['/proj/x/entrada', []]]);
    const events = new Map<string, () => void>();
    let ready = false;
    const notices: string[][] = [];
    const watch = new InboxWatch({
      folders: () => ['/proj/x'],
      notify: (_folder, names) => {
        if (!ready) return false;
        notices.push(names);
        return true;
      },
      quietMs: 500,
      retryMs: 5_000,
      ensureDir: (project) => ({ project, inbox: `${project}/entrada` }),
      readDir: (inbox) => files.get(inbox) ?? [],
      watchDir: (inbox, onEvent) => {
        events.set(inbox, onEvent);
        return { close: () => void events.delete(inbox), on: () => {} } as unknown as FSWatcher;
      },
    });
    watch.sync();
    files.set('/proj/x/entrada', [{ name: 'a.pdf', size: 4 }]);
    events.get('/proj/x/entrada')!();
    vi.advanceTimersByTime(1_000);
    expect(notices).toEqual([]);
    ready = true;
    vi.advanceTimersByTime(5_000);
    expect(notices).toEqual([['a.pdf']]);
    watch.stop();
    vi.useRealTimers();
  });
});

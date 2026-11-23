// Tela virtual (Xvfb) para o Chrome do escritório: a janela existe, recebe clique de verdade, e não aparece no monitor.
import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';

/** Faixa de displays que o escritório pode ocupar (`:40` … `:89`). */
const DISPLAY_MIN = 40;
const DISPLAY_MAX = 89;
/** Tamanho da tela virtual: maior que a viewport (1280×800) para a janela do Chrome caber. */
export const VIRTUAL_SCREEN = { width: 1600, height: 1000 };

export interface VirtualDisplay {
  /** Valor de `DISPLAY`, por exemplo `:47`. */
  display: string;
  stop(): Promise<void>;
}

/** Primeiro número livre em `[min, max]`. `taken(n)` verdadeiro = o display `:n` já existe. */
export function freeDisplay(taken: (n: number) => boolean, min = DISPLAY_MIN, max = DISPLAY_MAX): number | undefined {
  for (let n = min; n <= max; n++) if (!taken(n)) return n;
  return undefined;
}

/** Ambiente do Chrome: o display virtual, sem Wayland (senão a janela volta para o monitor). */
export function chromeEnv(display: string, base: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (v !== undefined && k !== 'WAYLAND_DISPLAY') env[k] = v;
  }
  env.DISPLAY = display;
  return env;
}

async function displayTaken(n: number): Promise<boolean> {
  try {
    await access(`/tmp/.X11-unix/X${n}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Sobe um Xvfb numa tela livre. Sem o programa, ou se ele não ficar pronto, devolve undefined
 * (o Chrome então abre sem janela e a imagem continua no escritório).
 */
export async function startVirtualDisplay(): Promise<VirtualDisplay | undefined> {
  const taken: boolean[] = [];
  for (let n = DISPLAY_MIN; n <= DISPLAY_MAX; n++) taken[n] = await displayTaken(n);
  const n = freeDisplay((i) => taken[i] === true);
  if (n === undefined) return undefined;
  const child = spawn('Xvfb', [`:${n}`, '-screen', '0', `${VIRTUAL_SCREEN.width}x${VIRTUAL_SCREEN.height}x24`, '-nolisten', 'tcp', '-ac'], { stdio: 'ignore' });
  const missing = await new Promise<boolean>((resolve) => {
    child.once('error', () => resolve(true));
    child.once('spawn', () => resolve(false));
  });
  if (missing) return undefined;
  const ready = await waitSocket(n, child);
  if (!ready) {
    await killChild(child);
    return undefined;
  }
  const onExit = () => {
    try {
      child.kill('SIGTERM');
    } catch {
      // já saiu
    }
  };
  process.on('exit', onExit);
  return {
    display: `:${n}`,
    async stop() {
      process.off('exit', onExit);
      await killChild(child);
    },
  };
}

async function waitSocket(n: number, child: ChildProcess): Promise<boolean> {
  const end = Date.now() + 3_000;
  while (Date.now() < end) {
    if (child.exitCode !== null) return false;
    if (await displayTaken(n)) return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}

function killChild(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // já saiu
      }
      resolve();
    }, 1_000);
    child.once('exit', () => {
      clearTimeout(t);
      resolve();
    });
    try {
      child.kill('SIGTERM');
    } catch {
      clearTimeout(t);
      resolve();
    }
  });
}

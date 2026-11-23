// Quadro do navegador do escritório: a imagem ao vivo do Chrome (tela virtual, fora do monitor).
// Clique, roda e teclado nesta imagem vão para a página. O botão some se o navegador está desligado.
import type { UiContext } from './context';
import { h, iconButton, setHidden, setText } from './dom';
import { ICONS } from './icons';
import { tr } from '../../../shared/i18n';

const POLL_MS = 500;
const HELP_EVENT = 'habblaud-browser';

const KEYS: Record<string, string> = {
  Enter: 'Enter',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Delete: 'Delete',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

export class BrowserStage {
  readonly el: HTMLDialogElement;
  readonly button: HTMLButtonElement;
  private readonly img: HTMLImageElement;
  private readonly empty: HTMLElement;
  private readonly url: HTMLElement;
  private blob?: string;
  private timer: number | undefined;
  private chain: Promise<void> = Promise.resolve();
  private polling = false;

  constructor(ctx: UiContext) {
    this.button = iconButton(ICONS.browser, tr('Ver o navegador do escritório'), () => this.toggle(), 'ui-btn-browser');
    this.button.hidden = true;
    this.button.setAttribute('aria-haspopup', 'dialog');
    const close = iconButton(ICONS.close, tr('Fechar navegador'), () => this.el.close(), 'ui-icon-btn--sm');
    this.url = h('p', { class: 'ui-browser__url' });
    this.img = h('img', {
      class: 'ui-browser__pic',
      attrs: { alt: tr('Página do navegador do escritório'), draggable: 'false', tabindex: '0' },
      hidden: true,
    });
    this.empty = h('p', { class: 'ui-browser__empty', text: tr('O navegador ainda não abriu uma página. Quando um agente abrir, a página aparece aqui e o Chrome fica fora da sua tela.') });
    this.img.addEventListener('pointerdown', (e) => this.onPointer(e));
    this.img.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.img.addEventListener('keydown', (e) => this.onKey(e));
    this.el = h(
      'dialog',
      { class: 'ui-dialog ui-browser', attrs: { 'aria-labelledby': 'ui-browser-title' } },
      h('div', { class: 'ui-dialog__head' }, h('h2', { attrs: { id: 'ui-browser-title' }, text: tr('Navegador') }), close),
      h(
        'div',
        { class: 'ui-dialog__body' },
        this.url,
        h('div', { class: 'ui-browser__stage' }, this.img, this.empty),
        h('p', { class: 'ui-browser__hint', text: tr('Clique na imagem para interagir. Digite com ela selecionada. O Chrome não abre janela na sua tela.') }),
      ),
    );
    this.el.addEventListener('close', () => this.stop());
    this.el.addEventListener('cancel', (e) => {
      e.preventDefault();
      this.el.close();
    });
    ctx.root.addEventListener(HELP_EVENT, () => this.open());
    void this.probe();
  }

  get isOpen(): boolean {
    return this.el.open;
  }

  toggle(): void {
    if (this.el.open) this.el.close();
    else this.open();
  }

  open(): void {
    if (!this.el.open) this.el.showModal();
    this.button.setAttribute('aria-expanded', 'true');
    this.loop();
  }

  private stop(): void {
    this.button.setAttribute('aria-expanded', 'false');
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.polling = false;
  }

  private loop(): void {
    if (this.polling) return;
    this.polling = true;
    const tick = () => {
      if (!this.el.open) {
        this.polling = false;
        return;
      }
      void this.frame().finally(() => {
        if (!this.el.open) {
          this.polling = false;
          return;
        }
        this.timer = window.setTimeout(tick, POLL_MS);
      });
    };
    tick();
  }

  private async probe(): Promise<void> {
    try {
      const res = await fetch('/api/browser/tela', { cache: 'no-store' });
      this.button.hidden = res.status === 503 || res.status === 403;
    } catch {
      this.button.hidden = true;
    }
  }

  private async frame(): Promise<void> {
    let res: Response;
    try {
      res = await fetch('/api/browser/tela', { cache: 'no-store' });
    } catch {
      this.showEmpty(tr('não deu para mostrar o navegador ({0})', [tr('sem conexão')]));
      return;
    }
    if (!this.el.open) return;
    if (res.status === 204) {
      this.showEmpty(tr('O navegador ainda não abriu uma página. Quando um agente abrir, a página aparece aqui e o Chrome fica fora da sua tela.'));
      return;
    }
    if (!res.ok) {
      this.showEmpty(tr('não deu para mostrar o navegador ({0})', [String(res.status)]));
      return;
    }
    const blob = await res.blob();
    if (!this.el.open) return;
    const next = URL.createObjectURL(blob);
    if (this.blob) URL.revokeObjectURL(this.blob);
    this.blob = next;
    this.img.src = next;
    setHidden(this.img, false);
    setHidden(this.empty, true);
    const pageUrl = safeDecode(res.headers.get('x-page-url'));
    const title = safeDecode(res.headers.get('x-page-title'));
    setText(this.url, pageUrl || title);
    this.img.alt = title || tr('Página do navegador do escritório');
  }

  private showEmpty(text: string): void {
    setHidden(this.img, true);
    setHidden(this.empty, false);
    setText(this.empty, text);
    setText(this.url, '');
  }

  private onPointer(e: PointerEvent): void {
    if (!this.img.naturalWidth || !this.img.naturalHeight) return;
    this.img.focus();
    const r = this.img.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return;
    const x = ((e.clientX - r.left) / r.width) * this.img.naturalWidth;
    const y = ((e.clientY - r.top) / r.height) * this.img.naturalHeight;
    this.send({ tipo: 'click', x, y });
  }

  private onWheel(e: WheelEvent): void {
    e.preventDefault();
    const dy = Math.max(-800, Math.min(800, e.deltaY));
    this.send({ tipo: 'rolar', dy });
  }

  private onKey(e: KeyboardEvent): void {
    if (e.key === 'Escape' || e.ctrlKey || e.metaKey || e.altKey) return;
    const name = KEYS[e.key];
    if (name) {
      e.preventDefault();
      e.stopPropagation();
      this.send({ tipo: 'tecla', tecla: e.shiftKey ? `Shift+${name}` : name });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      e.stopPropagation();
      this.send({ tipo: 'texto', texto: e.key });
    }
  }

  private send(body: { tipo: string; x?: number; y?: number; tecla?: string; texto?: string; dy?: number }): void {
    this.chain = this.chain
      .then(() => fetch('/api/browser/tela', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }))
      .then(() => undefined)
      .catch(() => undefined);
  }
}

function safeDecode(v: string | null): string {
  if (!v) return '';
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
}

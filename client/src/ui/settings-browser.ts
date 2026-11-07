// Grupo "Navegador" das configurações: modo da trava (Cauteloso / Equilibrado / Livre) e os sites confiáveis, pelo
// GET/PUT /api/browser/config (só pelo próprio computador). Vale na hora: o servidor lê a cada ação.
import { access } from '../net/access';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';
import { segmented } from './settings';
import { tr } from '../../../shared/i18n';

export type BrowserMode = 'cauteloso' | 'equilibrado' | 'livre';

export interface BrowserConfigView {
  modo: BrowserMode;
  sitesConfiaveis: string[];
}

const MODES: readonly BrowserMode[] = ['cauteloso', 'equilibrado', 'livre'];

/** Uma linha por modo (o que pede aprovação). */
export const MODE_HINTS: Readonly<Record<BrowserMode, string>> = {
  cauteloso: tr('Cauteloso: pede antes de enviar, salvar ou confirmar qualquer formulário, baixar e subir arquivos.'),
  equilibrado: tr('Equilibrado: pede só para pagar, excluir, mandar mensagem ou publicar e subir arquivos; o resto ele faz sozinho.'),
  livre: tr('Livre: pede só para pagamentos e no WhatsApp.'),
};

export function parseBrowserConfig(v: unknown): BrowserConfigView | undefined {
  const r = v as Partial<BrowserConfigView> | null;
  if (!r || !MODES.includes(r.modo as BrowserMode) || !Array.isArray(r.sitesConfiaveis) || !r.sitesConfiaveis.every((s) => typeof s === 'string')) return undefined;
  return { modo: r.modo as BrowserMode, sitesConfiaveis: r.sitesConfiaveis };
}

export class BrowserSettingsGroup {
  readonly el: HTMLElement;
  private mode: ReturnType<typeof segmented<BrowserMode>>;
  private hint: HTMLElement;
  private list: HTMLElement;
  private status: HTMLElement;
  private cfg: BrowserConfigView | undefined;
  private busy = false;
  private loading = false;

  constructor(private ctx: UiContext) {
    this.mode = segmented<BrowserMode>(
      tr('Quando pedir aprovação'),
      [
        ['cauteloso', tr('Cauteloso')],
        ['equilibrado', tr('Equilibrado')],
        ['livre', tr('Livre')],
      ],
      (v) => void this.save({ modo: v }),
    );
    this.hint = h('span', { class: 'ui-set__hint' });
    this.mode.row.append(this.hint, h('span', { class: 'ui-set__hint', text: tr('Pagamentos e o WhatsApp pedem sempre, em qualquer modo e em qualquer site.') }));
    this.list = h('ul', { class: 'ui-navsites', attrs: { 'aria-label': tr('Sites confiáveis') } });
    this.status = h('p', { class: 'ui-set__hint', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('Navegador') }),
      this.mode.row,
      h(
        'div',
        { class: 'ui-set ui-set--stack' },
        h('span', { class: 'ui-set__label', text: tr('Sites confiáveis') }),
        h('span', { class: 'ui-set__hint', text: tr('Nestes sites o navegador age como no modo Livre (pagamentos continuam pedindo). Para incluir um, use “Permitir e confiar neste site” no cartão de aprovação.') }),
        this.list,
      ),
      this.status,
    );
  }

  /** Só na página aberta pelo próprio computador, com o escritório ao vivo. */
  private available(): boolean {
    const a = access();
    return !this.ctx.store.mock && !this.ctx.store.replaying && !a.remote && a.local;
  }

  /** Chamado quando as configurações abrem (e a cada redesenho): busca a configuração uma vez por abertura. */
  render(opening = false): void {
    if (!this.available()) {
      setHidden(this.el, true);
      return;
    }
    if (opening) void this.load();
    setHidden(this.el, !this.cfg);
    if (!this.cfg) return;
    this.mode.set(this.cfg.modo);
    setText(this.hint, MODE_HINTS[this.cfg.modo]);
    this.renderSites(this.cfg.sitesConfiaveis);
  }

  private renderSites(sites: readonly string[]): void {
    if (!sites.length) {
      this.list.replaceChildren(h('li', { class: 'ui-set__hint', text: tr('Nenhum site confiável.') }));
      return;
    }
    this.list.replaceChildren(
      ...sites.map((site) =>
        h(
          'li',
          { class: 'ui-navsites__item' },
          h('code', { class: 'ui-navsites__site', text: site }),
          h('button', {
            class: 'ui-btn ui-btn--sm',
            type: 'button',
            text: tr('Remover'),
            title: tr('Deixa de confiar em {0}', [site]),
            attrs: { 'aria-label': tr('Remover {0} dos sites confiáveis', [site]) },
            on: { click: () => void this.save({ sitesConfiaveis: (this.cfg?.sitesConfiaveis ?? []).filter((s) => s !== site) }) },
          }),
        ),
      ),
    );
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const res = await fetch('/api/browser/config', { cache: 'no-store', credentials: 'same-origin' });
      const cfg = res.ok ? parseBrowserConfig(await res.json()) : undefined;
      // 503: navegador desligado; 403: acesso que não é local. Some o grupo.
      this.cfg = cfg;
    } catch {
      this.cfg = undefined;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async save(patch: Partial<BrowserConfigView>): Promise<void> {
    if (this.busy || !this.cfg) return;
    if (patch.modo && patch.modo === this.cfg.modo) return;
    this.busy = true;
    setText(this.status, tr('Salvando…'));
    try {
      const res = await fetch('/api/browser/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        credentials: 'same-origin',
      });
      const body: unknown = await res.json().catch(() => undefined);
      const cfg = res.ok ? parseBrowserConfig(body) : undefined;
      if (cfg) {
        this.cfg = cfg;
        setText(this.status, tr('Salvo: vale a partir da próxima ação do navegador.'));
        if (patch.modo) this.ctx.announce(MODE_HINTS[cfg.modo]);
      } else {
        const err = (body as { error?: unknown } | undefined)?.error;
        setText(this.status, typeof err === 'string' ? err : tr('Não foi possível salvar (erro {0}).', [res.status]));
      }
    } catch {
      setText(this.status, tr('Sem conexão com o beta-tester.'));
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

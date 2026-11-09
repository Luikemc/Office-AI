// Botões do agente local (Ollama) na gaveta: interromper o turno e tirar o agente do escritório
// (POST /api/local/agents/:id/interrupt e DELETE /api/local/agents/:id; server/local/http.ts). Só aparecem para
// agentes locais ao vivo, na página aberta pelo próprio computador. As mensagens vão pela caixa de sempre.
import type { AgentInfo } from '../../../shared/types';
import { tr } from '../../../shared/i18n';
import { access } from '../net/access';
import type { UiContext } from './context';
import { h, setHidden, setText } from './dom';

export class LocalAgentControls {
  readonly el: HTMLElement;
  private readonly stopBtn: HTMLButtonElement;
  private readonly closeBtn: HTMLButtonElement;
  private readonly status: HTMLElement;
  private id = '';
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.stopBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Interromper'), title: tr('Para o que o agente local está fazendo agora'), on: { click: () => void this.act('interrupt') } });
    this.closeBtn = h('button', { class: 'ui-btn', type: 'button', text: tr('Tirar do escritório'), title: tr('Encerra o agente local (a conversa fica gravada)'), on: { click: () => void this.act('close') } });
    this.status = h('span', { class: 'ui-set__hint', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.el = h('div', { class: 'ui-status ui-local-ctl', hidden: true }, h('span', { class: 'ui-status__label', text: tr('Agente local') }), h('span', { class: 'ui-status__actions' }, this.stopBtn, this.closeBtn), this.status);
  }

  render(a: AgentInfo | undefined, live: boolean): void {
    const on = !!a && live && a.provider === 'ollama' && a.kind === 'main' && access().localAi === true && !this.ctx.store.mock && !this.ctx.store.replaying;
    setHidden(this.el, !on);
    if (!on || !a) return;
    if (a.id !== this.id) {
      this.id = a.id;
      setText(this.status, '');
    }
    this.stopBtn.disabled = this.busy || a.status !== 'working';
    this.closeBtn.disabled = this.busy;
  }

  private async act(what: 'interrupt' | 'close'): Promise<void> {
    if (this.busy || !this.id) return;
    this.busy = true;
    this.stopBtn.disabled = this.closeBtn.disabled = true;
    const id = encodeURIComponent(this.id);
    try {
      const res = await fetch(what === 'interrupt' ? `/api/local/agents/${id}/interrupt` : `/api/local/agents/${id}`, {
        method: what === 'interrupt' ? 'POST' : 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string; interrupted?: boolean };
      if (!res.ok) setText(this.status, body.error ?? tr('erro {0}', [res.status]));
      else if (what === 'interrupt') setText(this.status, body.interrupted ? tr('Interrompido.') : tr('Não havia nada rodando.'));
      else this.ctx.announce(tr('Agente local saiu do escritório.'));
    } catch {
      setText(this.status, tr('Sem conexão com o beta-tester.'));
    } finally {
      this.busy = false;
      this.stopBtn.disabled = this.closeBtn.disabled = false;
    }
  }
}

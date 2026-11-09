// Grupo "IA local" das configurações: o Ollama deste computador (endereço, modelo padrão, tamanho do contexto e se o
// modelo pensa antes de responder), pelo GET /api/local/status e PUT /api/local/config (só pelo próprio computador).
// Vale para os próximos passos dos agentes locais; o modelo de um agente que já começou não muda.
import { access } from '../net/access';
import type { UiContext } from './context';
import { h, setAttr, setHidden, setText } from './dom';
import { segmented, switchRow } from './settings';
import { formatBytes, parseLocalStatus, type LocalStatusView } from './spawn';
import { tr } from '../../../shared/i18n';

type Ctx = '4096' | '8192' | '16384' | '32768';
const CONTEXTS: readonly Ctx[] = ['4096', '8192', '16384', '32768'];

export class LocalSettingsGroup {
  readonly el: HTMLElement;
  private readonly state: HTMLElement;
  private readonly url: HTMLInputElement;
  private readonly model: HTMLSelectElement;
  private readonly ctxSeg: ReturnType<typeof segmented<Ctx>>;
  private readonly think: ReturnType<typeof switchRow>;
  private readonly status: HTMLElement;
  private st?: LocalStatusView;
  private loading = false;
  private busy = false;

  constructor(private readonly ctx: UiContext) {
    this.state = h('p', { class: 'ui-set__hint' });
    this.url = h('input', { class: 'ui-rename__input', type: 'text', attrs: { 'aria-label': tr('Endereço do Ollama'), spellcheck: 'false', autocomplete: 'off', placeholder: 'http://127.0.0.1:11434' } });
    this.url.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') void this.save({ url: this.url.value.trim() });
    });
    this.url.addEventListener('keyup', (e) => e.stopPropagation());
    this.url.addEventListener('change', () => void this.save({ url: this.url.value.trim() }));
    this.model = h('select', { class: 'ui-rename__input', attrs: { 'aria-label': tr('Modelo padrão') } });
    this.model.addEventListener('change', () => void this.save({ modelo: this.model.value }));
    this.ctxSeg = segmented<Ctx>(
      tr('Contexto (quanto da conversa o modelo enxerga)'),
      CONTEXTS.map((c) => [c, `${Number(c) / 1024}k`] as [Ctx, string]),
      (v) => void this.save({ contexto: Number(v) }),
    );
    this.ctxSeg.row.append(h('span', { class: 'ui-set__hint', text: tr('Mais contexto usa mais memória. Agentes com o navegador usam no mínimo 16k; com 8 GB de RAM, 8k é o confortável para o resto.') }));
    this.think = switchRow(tr('Pensar antes de responder'), tr('Modelos como o qwen3 raciocinam antes; responde melhor, mas bem mais devagar na CPU.'), () => void this.save({ pensar: !this.st?.config.pensar }));
    this.status = h('p', { class: 'ui-set__hint', role: 'status', attrs: { 'aria-live': 'polite' } });
    this.el = h(
      'div',
      { class: 'ui-set-group', hidden: true },
      h('h3', { text: tr('IA local (Ollama)') }),
      this.state,
      h('div', { class: 'ui-set ui-set--stack' }, h('span', { class: 'ui-set__label', text: tr('Endereço do Ollama') }), this.url, h('span', { class: 'ui-set__hint', text: tr('Só deste computador (localhost ou 127.0.0.1).') })),
      h('div', { class: 'ui-set ui-set--stack' }, h('span', { class: 'ui-set__label', text: tr('Modelo padrão dos agentes novos') }), this.model),
      this.ctxSeg.row,
      this.think.row,
      this.status,
    );
  }

  private available(): boolean {
    const a = access();
    return !this.ctx.store.mock && !this.ctx.store.replaying && !a.remote && a.local && a.localAi === true;
  }

  render(opening = false): void {
    if (!this.available()) {
      setHidden(this.el, true);
      return;
    }
    if (opening) void this.load();
    setHidden(this.el, !this.st);
    const st = this.st;
    if (!st) return;
    setText(
      this.state,
      st.ok
        ? tr('Ollama {0} no ar, {1} modelo(s) instalado(s).', [st.version ?? '?', st.models.length])
        : tr('O Ollama não respondeu em {0}: {1}', [st.url, st.error ?? '']),
    );
    if (document.activeElement !== this.url) this.url.value = st.config.url;
    const names = st.models.map((m) => m.name);
    this.model.replaceChildren(
      h('option', { text: tr('O primeiro instalado'), attrs: { value: '' } }),
      ...st.models.map((m) => h('option', { text: `${m.name}${m.parameters ? ` · ${m.parameters}` : ''} · ${formatBytes(m.size)}`, attrs: { value: m.name } })),
      ...(st.config.modelo && !names.includes(st.config.modelo) ? [h('option', { text: tr('{0} (não instalado)', [st.config.modelo]), attrs: { value: st.config.modelo } })] : []),
    );
    this.model.value = st.config.modelo;
    const c = String(st.config.contexto) as Ctx;
    this.ctxSeg.set(CONTEXTS.includes(c) ? c : '8192');
    setAttr(this.think.btn, 'aria-checked', String(st.config.pensar));
  }

  private async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true;
    try {
      const res = await fetch('/api/local/status', { cache: 'no-store', credentials: 'same-origin' });
      this.st = res.ok ? parseLocalStatus(await res.json()) : undefined;
    } catch {
      this.st = undefined;
    } finally {
      this.loading = false;
      this.render();
    }
  }

  private async save(patch: Record<string, unknown>): Promise<void> {
    if (this.busy || !this.st) return;
    this.busy = true;
    setText(this.status, tr('Salvando…'));
    try {
      const res = await fetch('/api/local/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
        credentials: 'same-origin',
      });
      const body = (await res.json().catch(() => undefined)) as { error?: unknown } | undefined;
      if (res.ok) {
        setText(this.status, tr('Salvo: vale a partir do próximo passo dos agentes locais.'));
        this.busy = false;
        // O endereço pode ter mudado: busca de novo o estado e os modelos.
        await this.load();
        return;
      }
      setText(this.status, typeof body?.error === 'string' ? body.error : tr('Não foi possível salvar (erro {0}).', [res.status]));
    } catch {
      setText(this.status, tr('Sem conexão com o beta-tester.'));
    } finally {
      this.busy = false;
      this.render();
    }
  }
}

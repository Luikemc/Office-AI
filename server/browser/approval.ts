// A trava do navegador no registro de permissões (server/permissions/registry.ts): cada ação arriscada vira um
// pedido no escritório, na sala da sessão (status 'waiting', mão levantada). Fecha para o lado seguro: sem página
// aberta, sessão desconhecida, pedido expirado ou qualquer erro = recusado.
import { tr } from '../../shared/i18n';
import type { PermissionRegistry, SkipReason } from '../permissions/registry';
import { hostOf } from './gate';
import type { Gate, GateRequest } from './service';

/** Quanto o pedido espera a resposta (o MCP espera junto, numa requisição só). */
export const APPROVAL_TIMEOUT_MS = 5 * 60_000;
/** Nome da ferramenta no cartão (o servidor MCP do plugin se chama "navegador"). */
export const TOOL_PREFIX = 'mcp__navegador__';
const TYPED_MAX = 4_000;

export function skipMessage(skip: SkipReason, port: number): string {
  switch (skip) {
    case 'no-viewers':
      return tr('ninguém está com o escritório aberto para aprovar: peça ao usuário para abrir o Habblaud (http://localhost:{0}) e tente de novo. Nada foi feito.', [port]);
    case 'unknown-session':
      return tr('o escritório não conhece esta sessão: peça ao usuário para abrir o Habblaud (http://localhost:{0}) e conferir que a sessão aparece. Nada foi feito.', [port]);
    default:
      return tr('o escritório não aceitou o pedido de aprovação ({0}): peça ao usuário para abrir o Habblaud e tente de novo. Nada foi feito.', [skip]);
  }
}

/** Texto curto do cartão ("Clicar em “Enviar” em loja.com"). */
export function cardText(r: GateRequest): string {
  const site = hostOf(r.url) || r.url.slice(0, 60);
  if (r.tool === 'baixar') return tr('Baixar {0} de {1}', [r.element ?? tr('um arquivo'), site]);
  if (r.tool === 'digitar') return tr('Digitar e enviar em {0}', [site]);
  return tr('Clicar em {0} em {1}', [r.element ?? tr('um elemento'), site]);
}

/** Detalhe do cartão: site, elemento (o que a página diz e o que o agente diz), motivo e o texto exato. */
export function cardInput(r: GateRequest): string {
  const lines = [tr('Site: {0}', [r.url.slice(0, 500)]), tr('Por que pede: {0}', [r.reason])];
  if (r.element) lines.push(tr('Elemento na página: {0}', [r.element]));
  if (r.description) lines.push(tr('Descrição do agente: {0}', [r.description]));
  if (r.text !== undefined) {
    const t = r.text.length > TYPED_MAX ? `${r.text.slice(0, TYPED_MAX)}…` : r.text;
    lines.push(tr('Texto que será digitado:'), t);
  }
  return lines.join('\n');
}

export function registryGate(registry: PermissionRegistry, port: number, timeoutMs = APPROVAL_TIMEOUT_MS): Gate {
  return async (r) => {
    if (r.signal?.aborted) return { ok: false, message: tr('cancelado') };
    const res = registry.requestInternal({
      sessionId: r.sessionId,
      tool: `${TOOL_PREFIX}${r.tool}`,
      title: `${TOOL_PREFIX}${r.tool}(${hostOf(r.url) || r.url.slice(0, 80)})`,
      text: cardText(r),
      icon: r.tool === 'baixar' ? '⬇️' : r.tool === 'digitar' ? '⌨️' : '🖱️',
      input: cardInput(r),
      timeoutMs,
    });
    if ('skip' in res) return { ok: false, message: skipMessage(res.skip, port) };
    const onAbort = () => res.cancel();
    r.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const o = await res.result;
      if (o.status === 'decided' && o.behavior === 'allow') return { ok: true };
      if (o.status === 'decided' && o.behavior === 'deny') {
        return { ok: false, message: o.message ? tr('o usuário recusou no escritório: {0}', [o.message]) : tr('o usuário recusou no escritório. Não tente de novo nem por outro caminho; pergunte o que ele prefere.') };
      }
      if (o.status === 'released' && o.reason === 'gone') return { ok: false, message: tr('a sessão saiu do escritório antes da aprovação. Nada foi feito.') };
      if (o.status === 'released' && o.reason === 'expired') return { ok: false, message: tr('ninguém aprovou a tempo no escritório. Nada foi feito; avise o usuário.') };
      return { ok: false, message: tr('o pedido não foi aprovado ({0}). Nada foi feito.', [o.status === 'released' ? o.reason : o.behavior]) };
    } finally {
      r.signal?.removeEventListener('abort', onAbort);
    }
  };
}

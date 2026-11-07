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
const ICONS: Record<GateRequest['tool'], string> = { whatsapp_enviar: '💬', baixar: '⬇️', digitar: '⌨️', tecla: '⌨️', clicar: '🖱️', selecionar: '🖱️', enviar_arquivo: '📎', ajuda: '🙋' };

export function skipMessage(skip: SkipReason, port: number): string {
  switch (skip) {
    case 'no-viewers':
      return tr('ninguém está com o escritório aberto para aprovar: peça ao usuário para abrir o beta-tester (http://localhost:{0}) e tente de novo. Nada foi feito.', [port]);
    case 'unknown-session':
      return tr('o escritório não conhece esta sessão: peça ao usuário para abrir o beta-tester (http://localhost:{0}) e conferir que a sessão aparece. Nada foi feito.', [port]);
    default:
      return tr('o escritório não aceitou o pedido de aprovação ({0}): peça ao usuário para abrir o beta-tester e tente de novo. Nada foi feito.', [skip]);
  }
}

/** Texto curto do cartão ("Clicar em “Enviar” em loja.com"). */
export function cardText(r: GateRequest): string {
  const site = hostOf(r.url) || r.url.slice(0, 60);
  if (r.tool === 'whatsapp_enviar') return tr('Enviar no WhatsApp para {0}', [r.element ?? '?']);
  if (r.tool === 'baixar') return tr('Baixar {0} de {1}', [r.element ?? tr('um arquivo'), site]);
  if (r.tool === 'digitar') return tr('Digitar e enviar em {0}', [site]);
  if (r.tool === 'tecla') return tr('Apertar {0} em {1}', [r.text ?? '?', site]);
  if (r.tool === 'selecionar') return tr('Escolher {0} em {1}', [r.text ?? '?', site]);
  if (r.tool === 'enviar_arquivo') return tr('Enviar {0} arquivo(s) para {1}', [r.files?.length ?? 0, site]);
  if (r.tool === 'ajuda') return tr('Ajuda no navegador: {0} — faça na janela do Chrome e clique Permitir quando terminar', [(r.text ?? r.reason).slice(0, 120)]);
  return tr('Clicar em {0} em {1}', [r.element ?? tr('um elemento'), site]);
}

/** Detalhe do cartão: site, elemento (o que a página diz e o que o agente diz), motivo e o texto exato. */
export function cardInput(r: GateRequest): string {
  if (r.tool === 'whatsapp_enviar') {
    const t = (r.text ?? '').length > TYPED_MAX ? `${(r.text ?? '').slice(0, TYPED_MAX)}…` : (r.text ?? '');
    return [tr('Para: {0} (nome no cabeçalho da conversa aberta)', [r.element ?? '?']), tr('Mensagem que será enviada:'), t].join('\n');
  }
  if (r.tool === 'ajuda') {
    return [
      tr('O agente pede que você faça isto na janela do Chrome do escritório: {0}', [r.text ?? r.reason]),
      tr('Site: {0}', [r.url.slice(0, 500)]),
      tr('Faça na janela do Chrome (a aba foi trazida para a frente) e clique Permitir quando terminar. Recusar = “não vou fazer”.'),
      tr('Nunca mande senhas ou códigos no chat: digite só na página.'),
    ].join('\n');
  }
  const lines = [tr('Site: {0}', [r.url.slice(0, 500)]), tr('Por que pede: {0}', [r.reason])];
  if (r.element) lines.push(tr('Elemento na página: {0}', [r.element]));
  if (r.description) lines.push(tr('Descrição do agente: {0}', [r.description]));
  if (r.files?.length) lines.push(tr('Arquivos que serão enviados:'), ...r.files.map((f) => `- ${f}`));
  if (r.tool === 'tecla' && r.text !== undefined) lines.push(tr('Tecla: {0}', [r.text]));
  else if (r.tool === 'selecionar' && r.text !== undefined) lines.push(tr('Opção: {0}', [r.text]));
  else if (r.text !== undefined) {
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
      tool: `${TOOL_PREFIX}${toolName(r)}`,
      title: r.tool === 'whatsapp_enviar' ? `${TOOL_PREFIX}${r.tool}(${r.element ?? ''})` : `${TOOL_PREFIX}${toolName(r)}(${hostOf(r.url) || r.url.slice(0, 80)})`,
      text: cardText(r),
      icon: ICONS[r.tool] ?? '🖱️',
      input: cardInput(r),
      timeoutMs: r.timeoutMs ?? timeoutMs,
      // "Permitir e confiar neste site": nunca em pedir_ajuda nem no envio do WhatsApp.
      ...(r.trustSite && r.tool !== 'ajuda' && r.tool !== 'whatsapp_enviar' ? { trustSite: r.trustSite } : {}),
    });
    if ('skip' in res) return { ok: false, message: skipMessage(res.skip, port), skip: res.skip };
    const onAbort = () => res.cancel();
    r.signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const o = await res.result;
      if (o.status === 'decided' && o.behavior === 'allow') return o.trustSite ? { ok: true, trustSite: true } : { ok: true };
      if (o.status === 'decided' && o.behavior === 'deny' && r.tool === 'ajuda') {
        return { ok: false, message: o.message ? tr('o usuário disse que não vai fazer: {0}', [o.message]) : tr('o usuário disse que não vai fazer isso agora. Não tente contornar; pergunte no chat como ele prefere seguir.') };
      }
      if (o.status === 'decided' && o.behavior === 'deny') {
        return { ok: false, message: o.message ? tr('o usuário recusou no escritório: {0}', [o.message]) : tr('o usuário recusou no escritório. Não tente de novo nem por outro caminho; pergunte o que ele prefere.') };
      }
      if (o.status === 'released' && o.reason === 'gone') return { ok: false, message: tr('a sessão saiu do escritório antes da aprovação. Nada foi feito.') };
      if (o.status === 'released' && o.reason === 'expired' && r.tool === 'ajuda') return { ok: false, message: tr('o usuário não respondeu a tempo no escritório. Pergunte no chat se ele já fez e, se sim, chame `ler`.') };
      if (o.status === 'released' && o.reason === 'expired') return { ok: false, message: tr('ninguém aprovou a tempo no escritório. Nada foi feito; avise o usuário.') };
      return { ok: false, message: tr('o pedido não foi aprovado ({0}). Nada foi feito.', [o.status === 'released' ? o.reason : o.behavior]) };
    } finally {
      r.signal?.removeEventListener('abort', onAbort);
    }
  };
}

/** Nome da ferramenta no título do cartão (o pedido de ajuda é a ferramenta pedir_ajuda). */
function toolName(r: GateRequest): string {
  return r.tool === 'ajuda' ? 'pedir_ajuda' : r.tool;
}

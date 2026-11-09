// Aprovação no escritório para as ferramentas próprias do agente local (escrever_arquivo): o mesmo registro de
// permissões da trava do navegador (requestInternal), na sala do agente. Fecha para o lado seguro: sem página aberta,
// agente desconhecido, pedido expirado ou qualquer erro = recusado.
import { tr } from '../../shared/i18n';
import { skipMessage } from '../browser/approval';
import type { PermissionRegistry } from '../permissions/registry';
import type { Approve } from './files';

export const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export function registryApprove(registry: PermissionRegistry, port: number, sessionId: string, timeoutMs = APPROVAL_TIMEOUT_MS): Approve {
  return async (r, signal) => {
    if (signal?.aborted) return { ok: false, message: tr('cancelado') };
    const res = registry.requestInternal({ sessionId, tool: r.tool, title: r.title, text: r.text, icon: r.icon, input: r.input, timeoutMs });
    if ('skip' in res) return { ok: false, message: skipMessage(res.skip, port) };
    const onAbort = () => res.cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const o = await res.result;
      if (o.status === 'decided' && o.behavior === 'allow') return { ok: true };
      if (o.status === 'decided' && o.behavior === 'deny') {
        return { ok: false, message: o.message ? tr('o usuário recusou no escritório: {0}', [o.message]) : tr('o usuário recusou no escritório. Não tente de novo nem por outro caminho; pergunte o que ele prefere.') };
      }
      if (o.status === 'released' && o.reason === 'expired') return { ok: false, message: tr('ninguém aprovou a tempo no escritório. Nada foi feito; avise o usuário.') };
      return { ok: false, message: tr('o pedido não foi aprovado ({0}). Nada foi feito.', [o.status === 'released' ? o.reason : o.behavior]) };
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
  };
}

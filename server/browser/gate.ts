// Trava do navegador: quais ações esperam o seu ok no escritório. Fica no servidor (o modelo não decide) e erra para
// o lado de pedir: na dúvida, pede. Puro: recebe o que o serviço leu do elemento e devolve o motivo (ou nada).
import { tr } from '../../shared/i18n';

/**
 * Palavras (pt/en/es) de enviar, pagar, confirmar, apagar, publicar... Comparadas no começo de cada palavra do texto
 * sem acentos e em minúsculas ("Enviar mensagem", "Confirm order", "Eliminar cuenta").
 */
const RISKY_WORDS = [
  'envi', // enviar, envie, enviado, envío
  'send',
  'submi', // submit, submeter
  'pag(?:ar|ue|amento|o\\b)', // não "página"
  'pay',
  'compr(?:ar|e\\b|a\\b)',
  'buy',
  'purchase',
  'checkout',
  'finaliz',
  'conclu(?:ir|a\\b)',
  'confirm',
  'exclu(?:ir|a\\b|sao)',
  'apag',
  'delet',
  'remov',
  'elimin',
  'borrar',
  'publi(?:car|que|sh)',
  'post(?:ar|e|ou)?\\b',
  'tweet',
  'transfer',
  'pix\\b',
  'assin(?:ar|e)\\b',
  'subscri',
  'suscri',
  'doar\\b',
  'donat',
  'order\\b',
  'pedido\\b',
  'reservar\\b',
  'agendar\\b',
  'respond',
  'reply',
  'comment',
  'comentar\\b',
  'salvar',
  'save',
  'guardar',
  'aceit',
  'accept',
  'acept',
  'autoriz',
  'authoriz',
  'aprov',
  'approv',
  'cancel',
  'logout',
  'sair\\b',
];

const RISKY = new RegExp(`(?:^|[^a-z0-9])(?:${RISKY_WORDS.join('|')})`);

/** Sites em que toda ação que altera a página espera aprovação (mensagens saem em seu nome). */
const LOCKED_HOSTS = [/(^|\.)whatsapp\.com$/i, /(^|\.)whatsapp\.net$/i];

/** Sem acentos, minúsculo. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

/** O texto sugere enviar/pagar/confirmar/apagar/publicar? */
export function riskyText(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => !!t && RISKY.test(normalize(t)));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function lockedSite(url: string): boolean {
  const h = hostOf(url);
  return !!h && LOCKED_HOSTS.some((re) => re.test(h));
}

/** O que o serviço lê do elemento antes de agir (no próprio elemento e no alvo de clique mais próximo). */
export interface ElementFacts {
  role: string;
  /** Nome acessível (da fotografia). */
  name: string;
  tag?: string;
  /** Atributo type (button/input). */
  type?: string;
  /** Clicar nele envia um formulário (botão submit, input submit/image dentro de um <form>). */
  submits?: boolean;
  /** Está dentro de um <form>. */
  inForm?: boolean;
  /** Texto do formulário (aria-label, name, id, action). */
  formHint?: string;
  /** Texto, value, aria-label, title do alvo. */
  text?: string;
  href?: string;
}

export type BrowserAction =
  | { kind: 'clicar'; url: string; element: ElementFacts }
  | { kind: 'digitar'; url: string; element: ElementFacts; enviar: boolean }
  | { kind: 'download'; url: string };

/** Motivo para pedir aprovação (texto para o cartão), ou undefined = pode seguir. */
export function gateReason(a: BrowserAction): string | undefined {
  if (a.kind === 'download') return tr('baixar um arquivo');
  if (lockedSite(a.url)) return tr('ação no WhatsApp');
  const e = a.element;
  if (a.kind === 'digitar') return a.enviar ? tr('digitar e enviar (Enter)') : undefined;
  if (e.submits) return tr('enviar um formulário');
  if (e.type && /^(submit|image|reset)$/i.test(e.type)) return tr('enviar um formulário');
  if (riskyText(e.name, e.text)) return tr('botão que envia, paga, confirma ou apaga');
  // Botão dentro de formulário cujo próprio formulário fala em enviar/pagar.
  if (e.inForm && /^(button|link|menuitem)$/.test(e.role) && riskyText(e.formHint)) return tr('botão de um formulário que envia, paga ou confirma');
  return undefined;
}

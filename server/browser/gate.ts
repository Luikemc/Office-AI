// Trava do navegador: quais ações esperam o seu ok no escritório. Fica no servidor (o modelo não decide). Duas etapas,
// puras e por tabela:
//   1) classify(ação) → a categoria do risco (dinheiro, destrutivo, mensagem, upload, envio, download, whatsapp) ou nada;
//   2) needsApproval(categoria, modo, site confiável) → pede ou não.
// O modo (cauteloso / equilibrado / livre) e os sites confiáveis ficam em <dataDir>/navegador.json (config.ts).
// Livre (o padrão) não pede nada: pagar, apagar, publicar e o resto seguem direto. Ações no WhatsApp não pedem em modo nenhum.
import { tr } from '../../shared/i18n';

/** Categoria do risco de uma ação (undefined = só lê ou navega). */
export type GateCategory = 'dinheiro' | 'destrutivo' | 'mensagem' | 'upload' | 'envio' | 'download' | 'whatsapp';

export const BROWSER_MODES = ['cauteloso', 'equilibrado', 'livre'] as const;
export type BrowserMode = (typeof BROWSER_MODES)[number];
export const DEFAULT_MODE: BrowserMode = 'livre';

/**
 * O que pede aprovação em cada modo. Site confiável = `livre` naquele site.
 * WhatsApp (enviar mensagem, clique, tecla) segue sem cartão em qualquer modo.
 *   cauteloso:   tudo que envia, salva, confirma, baixa ou sobe arquivo;
 *   equilibrado: dinheiro, apagar/cancelar, mandar mensagem/publicar e subir arquivo;
 *   livre:       nada. Pagar, apagar, publicar, baixar e subir arquivo seguem direto.
 */
const ASKS: Readonly<Record<BrowserMode, ReadonlySet<GateCategory>>> = {
  cauteloso: new Set<GateCategory>(['dinheiro', 'destrutivo', 'mensagem', 'upload', 'envio', 'download']),
  equilibrado: new Set<GateCategory>(['dinheiro', 'destrutivo', 'mensagem', 'upload']),
  livre: new Set<GateCategory>(),
};

/** Categorias que pedem sempre: o cartão não oferece "confiar neste site" para elas. */
export const ALWAYS_ASK: ReadonlySet<GateCategory> = ASKS.livre;

export function isBrowserMode(v: unknown): v is BrowserMode {
  return typeof v === 'string' && (BROWSER_MODES as readonly string[]).includes(v);
}

/** A categoria pede aprovação neste modo? Modo desconhecido conta como cauteloso (na dúvida, pede). */
export function needsApproval(category: GateCategory | undefined, mode: BrowserMode, trusted = false): boolean {
  if (!category) return false;
  const set = trusted ? ASKS.livre : (ASKS[mode] ?? ASKS.cauteloso);
  return set.has(category);
}

// ------------------------------------------------------------------ palavras

/**
 * Trechos de expressão regular, comparados no começo de uma palavra do texto sem acentos e em minúsculas ("Pagar
 * agora", "Delete account", "Eliminar cuenta"). Cada trecho fecha a própria palavra com \b quando precisa: assim
 * "página" não casa com "pag…", "removível" não casa com "remov…", "Pagamentos" (o menu) não casa com "pagamento" e
 * "borrador" (rascunho, es) não casa com "borrar".
 */
const ART = '(?:(?:o|a|os|as|um|uma|seu|sua|meu|minha|the|my|your|an?|el|la|mi|su|tu) )?';

/** Pagar, comprar, transferir, assinar plano, doar (pt/en/es). Pede em todos os modos. */
const MONEY = [
  'pag(?:ar|ue|uei|amento)\\b', // não "página", não "Pagamentos" (o menu)
  'pay\\b',
  'payment\\b',
  'compr(?:ar|e|a)\\b', // não "Compras" (o menu)
  'buy\\b',
  'purchase\\b',
  'check ?out\\b',
  `(?:fazer|faca|finalizar|finalize|fechar|feche|concluir|conclua|confirmar|confirme|realizar|realice|efetuar|efetue|place|complete|submit|confirm|tramitar|enviar) ${ART}(?:pedido|order|orden)\\b`,
  'order now\\b',
  'pedir (?:agora|ja|ahora|ya)\\b',
  'transf(?:erir|ira|erencia|er)\\b', // não "Transferências" (o menu)
  'pix\\b',
  `assin(?:ar|e) ${ART}(?:plano|premium|pro|agora|ja)\\b`,
  `contrat(?:ar|e) ${ART}plano\\b`,
  'subscribe\\b',
  'suscrib(?:ir|irme|irse|ete)\\b',
  'upgrade\\b',
  'doar\\b',
  'doe agora\\b',
  'donat(?:e|ion)\\b',
  'donar\\b',
];

/** Apagar, excluir, cancelar conta/assinatura, revogar (pt/en/es). */
const DESTRUCTIVE = [
  'exclu(?:ir|a|sao)\\b',
  'apag(?:ar|ue|a)\\b',
  'remov(?:er|a|e)\\b', // não "removível", "removido"
  'delet(?:ar|e)\\b',
  'elimin(?:ar|e|a)\\b',
  'borr(?:ar|e)\\b', // não "borrador"
  `(?:cancel(?:ar|e|a)?|encerr(?:ar|e)|fech(?:ar|e)|close|desativ(?:ar|e)|deactivate|desactiv(?:ar|e)|terminate|dar de baja) ${ART}(?:conta|assinatura|plano|account|subscription|plan|membership|cuenta|suscripcion|perfil|profile)\\b`,
  'revog(?:ar|ue)\\b',
  'revoke\\b',
  'revoc(?:ar|ue)\\b',
  `esvazi(?:ar|e) ${ART}lixeira\\b`,
  'empty trash\\b',
];
/** Apagar um filtro, a busca ou um item do carrinho não é destrutivo. */
const DESTRUCTIVE_EXCEPT = /(?:^|[^a-z0-9])(?:filtros?|filters?|busca|pesquisa|search|selecao|selection|formatacao|formatting|carrinho|cart|carrito)\b/;

/** Mandar mensagem, e-mail, convite; publicar, postar, responder, comentar (pt/en/es). */
const MESSAGE = [
  'publi(?:car|que|sh)\\b',
  'post(?:ar|e)?\\b', // não "Postagens"
  'tweet(?:ar)?\\b',
  'tuit(?:ear)?\\b',
  `envi(?:ar|e|a) ${ART}(?:mensagem|mensagens|e-?mail|sms|convite|resposta|comentario|recado|mensaje|correo|dm)\\b`,
  `send ${ART}(?:message|e-?mail|sms|invite|invitation|reply|dm|text)\\b`,
  'respond(?:er|a)\\b',
  'reply\\b',
  'coment(?:ar|e)\\b',
  'comment\\b',
  'convid(?:ar|e)\\b',
  'invite\\b',
  'invitar\\b',
];

/**
 * "Enviar" / "Send" sozinhos: fora de um formulário costuma ser o botão de mandar de um app de mensagem ou e-mail
 * (mensagem); dentro de um <form>, um envio comum de formulário (envio). "Enviar arquivo" é a escolha do arquivo
 * (o upload tem a trava dele).
 */
const BARE_SEND = /(?:^|[^a-z0-9])(?:envi(?:ar|e|a)|send)\b(?! (?:o |os |um |uns )?(?:arquivos?|documentos?|fotos?|imagem|imagens|anexos?|files?|photos?|archivos?))/;

/** Modo cauteloso: o resto do que envia, salva, confirma, aceita, agenda, sai (a lista antiga). */
const SUBMIT = [
  'envi', // enviar, envie, enviado, envío
  'send',
  'submi', // submit, submeter
  'pag(?:ar|ue|amento|o\\b)',
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

/** Campo onde se escreve uma mensagem/comentário/post: Enter nele manda para alguém. */
const MESSAGE_FIELD = [
  'mensag',
  'messag',
  'mensaj',
  'coment',
  'comment',
  'repl(?:y|ies)\\b',
  'respost',
  'respuest',
  'chat\\b',
  'tweet',
  'post\\b',
  'what.?s on your mind',
  'no que voce esta pensando',
  'escreva uma',
  'write a',
];

const words = (list: string[]) => new RegExp(`(?:^|[^a-z0-9])(?:${list.join('|')})`);

/** Tabela das categorias "fortes" (pedem no equilibrado), na ordem em que se confere. */
const STRONG: ReadonlyArray<{ category: 'dinheiro' | 'destrutivo' | 'mensagem'; re: RegExp; except?: RegExp }> = [
  { category: 'dinheiro', re: words(MONEY) },
  { category: 'destrutivo', re: words(DESTRUCTIVE), except: DESTRUCTIVE_EXCEPT },
  { category: 'mensagem', re: words(MESSAGE) },
];
const SUBMIT_RE = words(SUBMIT);
const MESSAGE_FIELD_RE = words(MESSAGE_FIELD);

/** Sites em que toda ação que altera a página espera aprovação (mensagens saem em seu nome). */
const LOCKED_HOSTS = [/(^|\.)whatsapp\.com$/i, /(^|\.)whatsapp\.net$/i];

/** Sem acentos, minúsculo, espaços juntados. */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

function norm(s: string): string {
  return normalize(s).replace(/\s+/g, ' ').trim();
}

/** Categoria forte (dinheiro, destrutivo, mensagem) do texto, ou undefined. */
export function textCategory(...texts: Array<string | undefined>): 'dinheiro' | 'destrutivo' | 'mensagem' | undefined {
  const all = texts.filter((t): t is string => !!t).map(norm);
  for (const rule of STRONG) {
    if (all.some((t) => rule.re.test(t) && !rule.except?.test(t))) return rule.category;
  }
  return undefined;
}

/** O texto fala em enviar/salvar/confirmar/pagar/apagar... (a lista do modo cauteloso)? */
export function riskyText(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => !!t && SUBMIT_RE.test(norm(t)));
}

function bareSend(...texts: Array<string | undefined>): boolean {
  return texts.some((t) => !!t && BARE_SEND.test(norm(t)));
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

export function lockedHost(host: string): boolean {
  const h = host.toLowerCase().replace(/:\d+$/, '');
  return !!h && LOCKED_HOSTS.some((re) => re.test(h));
}

export function lockedSite(url: string): boolean {
  return lockedHost(hostOf(url));
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
  /** Campo onde se escreve (input de texto, textarea, select, contenteditable): Enter nele pode enviar o formulário. */
  editable?: boolean;
}

export type BrowserAction =
  | { kind: 'clicar'; url: string; element: ElementFacts }
  /** Clique por pixel da última foto (tela desenhada, sem elemento na leitura). `rotulo` é o que o agente diz que está clicando. */
  | { kind: 'ponto'; url: string; rotulo?: string }
  | { kind: 'digitar'; url: string; element: ElementFacts; enviar: boolean }
  | { kind: 'download'; url: string }
  /** Tecla na página; `element` = o elemento com o foco (undefined = não deu para saber: trava se a tecla envia). */
  | { kind: 'tecla'; url: string; key: string; element?: ElementFacts }
  | { kind: 'selecionar'; url: string }
  | { kind: 'arquivo'; url: string };

/** Última tecla de uma combinação ("Control+Enter" → "Enter"). */
function mainKey(key: string): string {
  const parts = key.split('+');
  return parts.at(-1) || (key.endsWith('+') ? '+' : key);
}

/** Botão, link ou item de menu (o que Enter/Espaço aciona). */
function pressable(e: ElementFacts): boolean {
  return /^(button|link|menuitem|menuitemcheckbox|menuitemradio|tab|switch|option)$/.test(e.role) || /^(button|a|summary)$/.test(e.tag ?? '') || (e.tag === 'input' && /^(submit|button|image|reset)$/.test(e.type ?? ''));
}

/** Clique (ou Enter/Espaço) num elemento. */
function classifyClick(e: ElementFacts): GateCategory | undefined {
  const own = textCategory(e.name, e.text);
  if (own) return own;
  const submitsForm = !!e.submits || /^(submit|image|reset)$/i.test(e.type ?? '');
  if (bareSend(e.name, e.text)) return e.inForm || submitsForm ? 'envio' : 'mensagem';
  // Botão de um formulário cujo próprio formulário fala em pagar/apagar/mandar mensagem ("checkout", "excluir-conta").
  const formButton = !!e.inForm && (submitsForm || /^(button|link|menuitem)$/.test(e.role));
  const form = formButton ? textCategory(e.formHint) : undefined;
  if (form) return form;
  if (submitsForm) return 'envio';
  if (riskyText(e.name, e.text)) return 'envio';
  if (formButton && riskyText(e.formHint)) return 'envio';
  return undefined;
}

/** Enter num campo (ou digitar com enviar): o formulário dele ou um campo de mensagem dizem o risco. */
function classifyFieldSubmit(e: ElementFacts): GateCategory {
  const form = e.inForm ? textCategory(e.formHint) : undefined;
  if (form) return form;
  if (MESSAGE_FIELD_RE.test(norm(`${e.name} ${e.text ?? ''}`))) return 'mensagem';
  return 'envio';
}

/** Categoria do risco da ação, ou undefined (só lê ou navega). Puro. */
export function classify(a: BrowserAction): GateCategory | undefined {
  if (a.kind === 'download') return 'download';
  if (lockedSite(a.url)) return 'whatsapp';
  if (a.kind === 'arquivo') return 'upload';
  if (a.kind === 'selecionar') return undefined;
  if (a.kind === 'digitar') return a.enviar ? classifyFieldSubmit(a.element) : undefined;
  if (a.kind === 'ponto') {
    const strong = textCategory(a.rotulo);
    if (strong) return strong;
    return riskyText(a.rotulo) ? 'envio' : undefined;
  }
  if (a.kind === 'tecla') {
    const k = mainKey(a.key);
    const enter = k === 'Enter' || k === 'NumpadEnter';
    const space = k === ' ' || k === 'Space';
    if (!enter && !space) return undefined;
    const f = a.element;
    // Foco que não dá para ver (iframe de outro site: pagamento, chat embutido): na dúvida, pede como mensagem.
    if (!f) return enter ? 'mensagem' : undefined;
    if (f.editable && enter) return classifyFieldSubmit(f);
    if (pressable(f)) return classifyClick(f);
    if (f.inForm && enter) return classifyFieldSubmit(f);
    return undefined;
  }
  return classifyClick(a.element);
}

/** Texto curto do motivo, para o cartão. */
export function categoryReason(c: GateCategory): string {
  switch (c) {
    case 'dinheiro':
      return tr('pagamento, compra ou transferência (sempre pede)');
    case 'destrutivo':
      return tr('excluir, apagar ou cancelar algo');
    case 'mensagem':
      return tr('mandar mensagem ou publicar para outras pessoas');
    case 'upload':
      return tr('enviar arquivos do seu computador para o site');
    case 'download':
      return tr('baixar um arquivo');
    case 'whatsapp':
      return tr('ação no WhatsApp');
    default:
      return tr('enviar, salvar ou confirmar um formulário (modo cauteloso)');
  }
}

/** Política em vigor para a ação: o modo e se o site dela é confiável. */
export interface GatePolicy {
  mode: BrowserMode;
  trusted: boolean;
}

/** Resultado da trava para uma ação: categoria e, se pede, o motivo. */
export interface GateVerdict {
  category: GateCategory | undefined;
  /** Motivo (texto do cartão) quando pede; undefined = pode seguir. */
  reason: string | undefined;
}

/** Classifica e decide. Sem política: cauteloso (na dúvida, pede). */
export function judge(a: BrowserAction, policy: GatePolicy = { mode: 'cauteloso', trusted: false }): GateVerdict {
  const category = classify(a);
  if (!needsApproval(category, policy.mode, policy.trusted)) return { category, reason: undefined };
  let reason = categoryReason(category!);
  if (a.kind === 'tecla') {
    const k = mainKey(a.key);
    reason = !a.element && category === 'mensagem' ? tr('apertar Enter sem saber onde está o foco (pode enviar)') : tr('apertar {0}: {1}', [k === ' ' ? tr('Espaço') : k, reason]);
  } else if (a.kind === 'digitar' && a.enviar) reason = tr('digitar e enviar (Enter): {0}', [reason]);
  return { category, reason };
}

/** Motivo para pedir aprovação (texto do cartão), ou undefined = pode seguir. */
export function gateReason(a: BrowserAction, policy?: GatePolicy): string | undefined {
  return judge(a, policy).reason;
}

# Escritório IA — plano e decisões

Base: fork local do Habblaud (MIT, aviso de copyright mantido em `LICENSE`). O OpenBot (PolyForm Noncommercial)
serve só de referência de arquitetura: nenhuma linha de código dele entra aqui.

## Decisões (6 nov 2026)

- **Sem chave de API.** O cérebro é o Claude Code já logado na máquina.
- **Navegador dentro do servidor do escritório** (`server/browser/`). Um único processo é dono do Chromium
  (perfil persistente só aceita um processo). Usa `playwright-core` (já é dependência) com o Chrome do sistema.
- **Ferramenta própria, não `@playwright/mcp`.** Ele expõe `evaluate`/`run_code_unsafe` sem como desligar
  (furam a trava) e está em versão 0.0.x/alpha.
- **MCP fino por sessão** (`mod/navegador`): stdio, sem dependências, repassa para `127.0.0.1:<porta>/api/browser/*`.
  Identifica a sessão por `~/.claude/sessions/<ppid>.json`.
- **Trava no servidor, não no modelo.** Ações que enviam/submetem/pagam pedem aprovação pelo registro de
  permissões já existente (`server/permissions`): a sala levanta a mão. Sem escritório aberto, a ação é recusada.
  No `web.whatsapp.com` o envio e as ações na página seguem sem cartão. Quanto pedir nas outras ações é escolha do usuário (modo e sites confiáveis), mas
  dinheiro pede sempre e, quando a trava pede, falha = a ação não roda.
- **Documentos** (`mod/documentos`): MCP local que extrai texto/valores com referência (página, célula) e faz as
  contas em código. A correção vai sempre para `nome-corrigido.ext`; o original nunca é sobrescrito.

## Etapas

1. Escritório em pé — feito: roda com Node 24 (`nvm use 24`) em `HABBLAUD_PORT=4748`, enquanto o Habblaud
   original ocupa a 4747.
2. Navegador local (abrir, ler, clicar, digitar).
3. Confirmação antes de agir.
4. WhatsApp Web — `whatsapp_status`, `whatsapp_enviar` (sem cartão), `whatsapp_ler` (`server/browser/whatsapp.ts`).
5. Documentos (em paralelo com 2–3).
6. Navegador para sistemas de verdade — `navegar`, `rolar` e `ler parte` (páginas longas), `tecla`, `selecionar`,
   `passar_mouse`, `esperar`, `ver_tela` (JPEG para o modelo), `pedir_ajuda` (login/captcha/2FA/QR com o usuário,
   pelo cartão do escritório; o modelo nunca digita senha) e `enviar_arquivo` (só da pasta do projeto, sempre com
   aprovação). Sistema de mentira para testar: `npm run sistema:exemplo` (porta 4800, `admin`/`exemplo123`).
   Porta padrão do beta-tester agora é 4748 (`server/config.ts`, `vite.config.ts`, MCP `navegador`); os hooks
   `habblaud*` seguem na 4747 (compartilhados com o Habblaud original).
7. Trava com menos pedidos (7 nov 2026, depois do teste real login → tabela → "Novo cliente" → anexo → Salvar, que
   pedia aprovação demais): modos `cauteloso` / `equilibrado` (padrão) / `livre` e sites confiáveis em
   `<dataDir>/navegador.json`. Equilibrado pede só dinheiro, destrutivo, mensagem/publicar e upload; pagamento e
   pagamentos pedem sempre; o WhatsApp envia sem cartão; site confiável = livre. Cartão com "Permitir e confiar neste site"; Configurações ›
   Navegador escolhe o modo e tira sites (`GET/PUT /api/browser/config`). Classificador por tabela em
   `server/browser/gate.ts` (`classify` + `needsApproval`).

8. IA local com o Ollama (8 nov 2026): `server/local/`. Um agente próprio dentro do servidor (não o Claude Code
   apontado para o Ollama: o pedido de sistema e as ferramentas do Claude Code passam de 20 mil tokens, que um modelo
   de 4B na CPU desta máquina — i5-8265U, 7 GB de RAM, sem GPU NVIDIA — leva minutos só para ler). Fala com a API
   nativa do Ollama (`/api/chat` com ferramentas, streaming); grava o transcript no formato do Claude Code em
   `<dataDir>/ia-local/`, que passa pelo mesmo parser (atividades, terminal, números). Ferramentas: `files.ts`
   (listar, ler, escrever com aprovação, presos à pasta) e os MCP dos plugins `documentos` e `navegador` como
   processos filhos (`mcp.ts`; `HABBLAUD_NAVEGADOR_SESSION` = sessão do agente, então as travas e a sala são as
   mesmas). Descrições das ferramentas encurtadas e `ver_tela` fora (o modelo não recebe imagens); com o navegador o
   contexto mínimo é 16k. Rotas `/api/local/*` só pelo próprio computador; mensagens pelo `MessageRegistry`
   (entrega direta). Provider novo `ollama` (conta "Ollama (local)", sem cartão de uso). Outras IAs (LM Studio,
   llama.cpp) ficam para depois: o caminho é trocar `ollama.ts` pela API compatível com OpenAI.

## Notas

- Testes: algumas falhas por timeout de 5s nesta máquina (lenta), variam a cada execução.
- `findRoot` exige `package.json` com name `habblaud`: não renomear o pacote por enquanto.

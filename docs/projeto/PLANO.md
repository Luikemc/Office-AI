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
  No `web.whatsapp.com` toda ação que altera a página é travada.
- **Documentos** (`mod/documentos`): MCP local que extrai texto/valores com referência (página, célula) e faz as
  contas em código. A correção vai sempre para `nome-corrigido.ext`; o original nunca é sobrescrito.

## Etapas

1. Escritório em pé — feito: roda com Node 24 (`nvm use 24`) em `HABBLAUD_PORT=4748`, enquanto o Habblaud
   original ocupa a 4747.
2. Navegador local (abrir, ler, clicar, digitar).
3. Confirmação antes de agir.
4. WhatsApp Web — `whatsapp_status`, `whatsapp_enviar` (com trava), `whatsapp_ler` (`server/browser/whatsapp.ts`).
5. Documentos (em paralelo com 2–3).
6. Navegador para sistemas de verdade — `navegar`, `rolar` e `ler parte` (páginas longas), `tecla`, `selecionar`,
   `passar_mouse`, `esperar`, `ver_tela` (JPEG para o modelo), `pedir_ajuda` (login/captcha/2FA/QR com o usuário,
   pelo cartão do escritório; o modelo nunca digita senha) e `enviar_arquivo` (só da pasta do projeto, sempre com
   aprovação). Sistema de mentira para testar: `npm run sistema:exemplo` (porta 4800, `admin`/`exemplo123`).
   Porta padrão do beta-tester agora é 4748 (`server/config.ts`, `vite.config.ts`, MCP `navegador`); os hooks
   `habblaud*` seguem na 4747 (compartilhados com o Habblaud original).

## Notas

- Testes: algumas falhas por timeout de 5s nesta máquina (lenta), variam a cada execução.
- `findRoot` exige `package.json` com name `habblaud`: não renomear o pacote por enquanto.

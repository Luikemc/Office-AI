# Estudo: como o escritório usa cada IA, como escolher e o que melhorar

Estado em 8 nov 2026, na branch `escritorio-ia`. Base de comparação: o Habblaud original (`~/Projetos/habblaud`,
versão 1.0.3), de onde este projeto saiu.

## 1. Dois jeitos de ter uma IA no escritório

O escritório trabalha com IAs de dois jeitos bem diferentes. Entender isso resolve quase todas as dúvidas.

**Jeito A: observar um agente de terminal.** O Claude Code e o Codex são programas que você abre no terminal. Eles
têm o próprio login, o próprio modelo e as próprias ferramentas. O escritório não conversa com o modelo: ele lê os
arquivos que o programa grava no disco e recebe avisos dos hooks. É assim que o Habblaud funciona desde o começo.
Não precisa de chave de API: vale a assinatura de cada um.

**Jeito B: o próprio escritório roda o agente.** É o que entrou na etapa 8 com o Ollama. O servidor do escritório
conversa direto com o modelo, executa as ferramentas e grava a conversa. Aqui quem escolhe o modelo é você, na tela
de Novo agente. Para modelos locais não há chave; para modelos na nuvem, a chave de API é obrigatória.

| | Jeito A: observar | Jeito B: rodar |
| --- | --- | --- |
| Exemplos | Claude Code, Codex, Gemini CLI ou Antigravity CLI | Ollama hoje; APIs na nuvem no futuro |
| Quem conversa com o modelo | o programa da IA | o servidor do escritório |
| Login | o do programa (assinatura) | nenhum (local) ou chave de API (nuvem) |
| Onde escolhe o modelo | dentro do programa (`/model`, `-m`) | Novo agente › Modelo |
| Ferramentas | as do programa, mais os plugins MCP instalados nele | arquivos, documentos e navegador do escritório |
| Qualidade | a do modelo do programa, em geral alta | depende do modelo; local e pequeno é fraco |

## 2. O que cada ferramenta consegue hoje

O Habblaud liga cada ferramenta em camadas. Cada camada exige algo da ferramenta: um arquivo legível, um hook, um
comando para mandar mensagem.

| Camada | Claude Code | Codex | Ollama (agente do escritório) | Gemini CLI |
| --- | --- | --- | --- | --- |
| Aparece no escritório | sim, lendo `~/.claude` | sim, lendo `~/.codex` | sim | ver seção 3 |
| Ao vivo (trabalhando, esperando) | sim | com `npm run codex:install` | sim | ver seção 3 |
| Aprovar pelo escritório | sim (plugin habblaud-permissoes) | sim, até 25 s por pedido | sim (escrever, navegador) | ver seção 3 |
| Mandar mensagem | sim (plugin habblaud-mensagens) | sim (`codex queue`) | sim | ver seção 3 |
| Uso do plano (5 h e semanal) | sim (mod habblaud) | sim, lendo os arquivos | não se aplica | ver seção 3 |
| Novo agente pelo escritório | sim, só com `HABBLAUD_PTY=1` | não | sim | não |
| Terminal interativo (assumir daqui) | sim, só com `HABBLAUD_PTY=1` | não | não se aplica | não |
| Navegador e documentos | sim, como plugins | não instalados | sim | não |
| Escolher o modelo | no Claude Code | no Codex | na tela do escritório | no Gemini CLI |

Duas observações sobre esta máquina:

- O comando que você usa para subir o escritório não liga `HABBLAUD_PTY=1`. Por isso o Novo agente só oferece o
  Ollama: o do Claude Code está desligado.
- Só o Claude Code está instalado aqui. O Codex e o Gemini CLI não estão.

## 3. O Gemini CLI

**Primeiro, a mudança mais importante.** Em 19 de maio de 2026 o Google anunciou que o Gemini CLI seria
substituído pelo **Antigravity CLI** (comando `agy`, escrito em Go). Desde 18 de junho de 2026 o Gemini CLI parou de
atender o login gratuito e os planos Google AI Pro e Ultra. Ele continua só para empresas (Code Assist Standard e
Enterprise) e para quem usa chave de API do Gemini ou do Vertex. Fonte:
[blog do Google](https://developers.googleblog.com/an-important-update-transitioning-gemini-cli-to-antigravity-cli/).

Então, para quem usa uma conta Google comum, o alvo certo é o **Antigravity CLI**, não o Gemini CLI.

### Dá para usar do mesmo jeito que o Claude Code?

Sim, pelo Jeito A, com as mesmas camadas. O Gemini CLI (pesquisado no código da versão 0.67, de 4 nov 2026) tem o que
o Habblaud precisa:

| Camada | Como seria no Gemini CLI | Comparado com |
| --- | --- | --- |
| Aparece no escritório | lendo `~/.gemini/tmp/<projeto>/chats/*.jsonl`, um arquivo por sessão, com `~/.gemini/projects.json` dizendo a pasta de cada projeto | igual ao Claude e ao Codex |
| Ao vivo | hooks `SessionStart`, `BeforeAgent`, `AfterAgent`, `BeforeTool`, `AfterTool`, `Notification`, `SessionEnd` | igual aos hooks do Codex |
| Aprovar pelo escritório | o hook `BeforeTool` pode recusar e esperar a resposta por até 60 s, mas a documentação não diz que um "permitir" pula a pergunta no terminal | mais fraco que o Claude, parecido com o Codex |
| Mandar mensagem | não há forma documentada de digitar numa sessão aberta; só o modo ACP, em que um programa controla a sessão de fora | mais fraco que o Claude e o Codex |
| Uso e tokens | os tokens vêm em cada resposta no arquivo da sessão; a cota restante não fica no disco | tokens sim, limite de uso não |
| Navegador e documentos | servidores MCP em `~/.gemini/settings.json` (`mcpServers`) ou numa extensão | igual |
| Escolher o modelo | `gemini -m pro`, `-m flash` ou `/model` | igual |

Diferença que pesa: o Gemini CLI não tem um registro de sessões abertas como o `~/.claude/sessions/<pid>.json`. O
escritório teria que adivinhar se a sessão está aberta pelo arquivo recente e pelos hooks, como já faz com o Codex.

### E o Antigravity CLI?

A documentação oficial confirma plugins com `plugin.json`, `hooks.json` e `mcp_config.json`, hooks no
`settings.json` e servidores MCP ([plugins](https://antigravity.google/docs/cli/plugins),
[MCP](https://antigravity.google/docs/mcp)). Não achei documentação oficial de onde ele grava as conversas nem do
formato. Por isso, antes de prometer o Antigravity no escritório, é preciso instalar e olhar os arquivos que ele grava,
como foi feito com o Codex.

### Gemini sem o programa

Há ainda um terceiro caminho: o modelo Gemini pela API, como agente do escritório (Jeito B). Precisa de chave de API do
Google AI Studio, que tem uma faixa gratuita pequena. A API do Gemini aceita o formato da OpenAI, então entra pelo
mesmo adaptador das outras APIs (item 4 da seção 5).

## 4. Como escolher e usar cada um (tutorial)

### Claude Code

1. Abra um terminal na pasta do projeto e rode `claude`. A sessão aparece no escritório em segundos.
2. Para trocar o modelo, digite `/model` dentro da sessão, ou abra com `claude --model <nome>`.
3. Aprovações e mensagens pelo escritório precisam dos plugins: rode `npm run mod:install` uma vez. Para o navegador
   e os documentos, acrescente `-- --com-navegador --com-documentos`.
4. Para abrir sessões pelo botão Novo agente, suba o escritório com `HABBLAUD_PTY=1`:

   ```
   HABBLAUD_PTY=1 HABBLAUD_WORLD=0 HABBLAUD_DATA_DIR=$HOME/.escritorio-ia npx tsx server/index.ts
   ```

### Codex

1. Instale o Codex e faça login. O escritório acha a pasta `~/.codex` sozinho.
2. Para ver ao vivo e aprovar pelo escritório, rode `npm run codex:install` e aprove os hooks em `/hooks` dentro do
   Codex.
3. O modelo se escolhe no Codex (`codex -m <nome>` ou `/model`).
4. Mensagens pelo escritório funcionam com o `codex` no PATH.

### Ollama (agente do escritório)

1. Deixe o Ollama rodando no computador, com pelo menos um modelo (`ollama pull qwen3:4b`).
2. No escritório, abra Configurações › IA local e confira se aparece "Ollama no ar". Escolha o modelo padrão e o
   contexto.
3. Clique em Novo agente, escolha "Ollama (local)", a pasta, o modelo e as ferramentas, e clique em Começar.
4. O agente aparece na sala. Mande mensagens pela caixa do cartão dele. Para parar, use Interromper ou Tirar do
   escritório.

### Gemini CLI

Só vale para quem tem licença Code Assist de empresa ou chave de API, por causa da mudança de junho de 2026.

1. Instale com `npm install -g @google/gemini-cli` e entre com `gemini`.
2. Escolha o modelo com `gemini -m pro`, `gemini -m flash` ou `/model` dentro da sessão.
3. Hoje o escritório ainda **não** mostra o Gemini CLI. Isso depende do item 3 da seção 5.

Com conta Google comum, use o Antigravity CLI (`agy`). Ele também ainda não aparece no escritório.

## 5. O que melhorar

Em ordem de valor para você, do mais útil ao menos.

1. **Uma tela "IAs do computador".** Hoje cada ferramenta tem a sua instrução espalhada no README. Uma seção nas
   Configurações listaria cada IA, se está instalada, quais camadas estão ligadas e o comando que falta para ligar
   cada uma, como o `codex:status` faz para o Codex. É o tutorial dentro do próprio escritório.
2. **Novo agente com todas as IAs.** O botão abriria Claude Code, Codex, Gemini CLI ou um agente do escritório, com a
   escolha do modelo em todos. O Claude aceita `--model` e o Codex aceita `-m` ao abrir. Hoje só o Claude abre, e
   só com `HABBLAUD_PTY=1`.
3. **Google como terceira ferramenta observada.** Primeiro instalar o Antigravity CLI e estudar os arquivos que ele
   grava. Se forem parecidos com os do Gemini CLI, a integração segue o caminho do Codex. Detalhes na seção 3.
4. **Conexões de IA para o agente do escritório.** Um adaptador compatível com a API da OpenAI cobre OpenAI, Gemini
   pela API, OpenRouter, Groq, DeepSeek, LM Studio e llama.cpp. A chave fica só no servidor, com aviso de custo e de
   privacidade. É a análise anterior.
5. **Navegador e documentos no Codex e no Gemini.** Os dois aceitam servidores MCP. Instalar os nossos neles dá as
   mesmas ferramentas e as mesmas travas para as três IAs.
6. **Uma tabela única de ferramentas no código.** Hoje o código tem 65 testes do tipo "é o Codex?" espalhados em 25
   arquivos. Cada ferramenta nova repete esse trabalho. Uma tabela com nome, letra, cor e camadas de cada
   ferramenta deixa o Gemini e as próximas bem mais baratas de entrar.
7. **Agentes do escritório que voltam depois de reiniciar.** A conversa já fica gravada; falta reabrir.
8. **Habblaud World:** contar cada ferramenta pelo nome certo antes de ligar o World. Hoje um agente do Ollama seria
   enviado como Claude Code. Exige seguir as regras de `shared/world/README.md`.
9. **Arrumações pequenas:** 102 textos do navegador sem tradução, e um teste do World que já falhava antes desta
   etapa.

## 6. Decisões que dependem de você

- Por onde começar: a tela "IAs do computador", o Gemini CLI observado ou as conexões com chave de API.
- Se vale instalar o Antigravity CLI e o Codex nesta máquina para testar de verdade.
- Se a chave de API pode ficar guardada no servidor ou só em variável de ambiente.

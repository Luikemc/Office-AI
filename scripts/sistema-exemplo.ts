// npm run sistema:exemplo — sobe o "Sistema Exemplo" (server/test/sistema-fixture.ts), um sistema interno de mentira
// para testar o navegador do escritório à mão: login, menu de passar o mouse, tabela longa, formulário com <select>,
// checkbox e arquivo, página lenta e gráfico em canvas. Só no 127.0.0.1. SISTEMA_PORT troca a porta (padrão 4800).
import { CREDENCIAIS, startSistemaExemplo } from '../server/test/sistema-fixture';

const port = Number.parseInt(process.env.SISTEMA_PORT ?? '', 10) || 4800;
const app = await startSistemaExemplo(port);
console.log(`Sistema Exemplo em ${app.base}/login`);
console.log(`Usuário: ${CREDENCIAIS.usuario}  ·  Senha: ${CREDENCIAIS.senha}`);
console.log('Páginas: /painel (menu Cadastros), /clientes (300 linhas), /clientes/novo (formulário), /relatorio (lento), /grafico (canvas).');
console.log('Ctrl+C para parar.');
const stop = () => void app.close().then(() => process.exit(0));
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

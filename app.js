const express = require('express');
const bodyParser = require('body-parser');
const { Pool } = require('pg');

const app = express();

app.use(bodyParser.urlencoded({ extended: true }));

// ---------------- BANCO ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

async function dbGet(query, params = []) {
  const result = await pool.query(query, params);
  return result.rows[0];
}

async function dbAll(query, params = []) {
  const result = await pool.query(query, params);
  return result.rows;
}

async function dbRun(query, params = []) {
  const result = await pool.query(query, params);
  return result;
}

async function initDB() {
  await dbRun(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id SERIAL PRIMARY KEY,
      codigo TEXT UNIQUE,
      cliente TEXT,
      produto TEXT,
      peso TEXT,
      origem TEXT,
      destino TEXT,
      modalidade TEXT,
      observacao TEXT,
      prazo_dias INTEGER,
      previsao_entrega TEXT,
      status_atual TEXT,
      created_at TEXT
    )
  `);

  await dbRun(`
    CREATE TABLE IF NOT EXISTS eventos (
      id SERIAL PRIMARY KEY,
      pedido_id INTEGER,
      status TEXT,
      local TEXT,
      data_evento TEXT,
      FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
    )
  `);

  // Garante colunas extras caso o banco já exista de antes
  const colunasPedidos = (await dbAll(`
    SELECT column_name
    FROM information_schema.columns
    WHERE table_name = 'pedidos'
  `)).map(c => c.column_name);

  const colunasNecessarias = {
    produto: 'TEXT',
    peso: 'TEXT',
    observacao: 'TEXT',
    previsao_entrega: 'TEXT'
  };

  for (const [coluna, tipo] of Object.entries(colunasNecessarias)) {
    if (!colunasPedidos.includes(coluna)) {
      try {
        await dbRun(`ALTER TABLE pedidos ADD COLUMN ${coluna} ${tipo}`);
      } catch (e) {}
    }
  }
}

// ---------------- CONFIG ----------------
const ADMIN_USER = 'admin';
const ADMIN_PASS = '123456';
let logged = false;

const ESTADOS = [
  'Acre', 'Alagoas', 'Amapá', 'Amazonas', 'Bahia', 'Ceará', 'Distrito Federal',
  'Espírito Santo', 'Goiás', 'Maranhão', 'Mato Grosso', 'Mato Grosso do Sul',
  'Minas Gerais', 'Pará', 'Paraíba', 'Paraná', 'Pernambuco', 'Piauí',
  'Rio de Janeiro', 'Rio Grande do Norte', 'Rio Grande do Sul', 'Rondônia',
  'Roraima', 'Santa Catarina', 'São Paulo', 'Sergipe', 'Tocantins'
];

const EVENTOS_PADRAO = [
  'Pedido confirmado',
  'Pagamento aprovado',
  'Pedido faturado',
  'Objeto coletado',
  'Objeto despachado',
  'Em trânsito',
  'Chegou ao centro de distribuição',
  'Saiu para entrega'
];

// ---------------- FUNÇÕES ----------------
function gerarCodigo() {
  const letras = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const randLetra = () => letras[Math.floor(Math.random() * letras.length)];
  const randNumero = () => Math.floor(Math.random() * 10);

  let prefixo = randLetra() + randLetra();
  let numeros = '';
  for (let i = 0; i < 9; i++) numeros += randNumero();
  return `${prefixo}${numeros}BR`;
}

function formatarData(date) {
  return date.toISOString().split('T')[0];
}

function formatarDataBR(dataISO) {
  if (!dataISO) return '-';
  const [ano, mes, dia] = dataISO.split('-');
  return `${dia}/${mes}/${ano}`;
}

function parseDateOnly(dataISO) {
  return new Date(`${dataISO}T00:00:00`);
}

function getHoje() {
  return formatarData(new Date());
}

function escapeHtml(str = '') {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function optionsEstados(selected = '') {
  return ESTADOS.map(estado => `<option value="${estado}" ${selected === estado ? 'selected' : ''}>${estado}</option>`).join('');
}

function optionsModalidade(selected = '') {
  const modalidades = ['Entrega padrão', 'Entrega expressa', 'Entrega econômica'];
  return modalidades.map(item => `<option value="${item}" ${selected === item ? 'selected' : ''}>${item}</option>`).join('');
}

function gerarTimeline(prazo, origem, destino) {
  const totalEventos = EVENTOS_PADRAO.length;
  const hoje = new Date();
  const timeline = [];

  for (let i = 0; i < totalEventos; i++) {
    const data = new Date(hoje);
    const offset = Math.round((i * prazo) / (totalEventos - 1));
    data.setDate(data.getDate() + offset);

    const local = i < 5 ? origem : destino;
    timeline.push({
      status: EVENTOS_PADRAO[i],
      local,
      data: formatarData(data)
    });
  }

  return timeline;
}

async function calcularStatusAtual(pedidoId) {
  const evento = await dbGet(`
    SELECT * FROM eventos
    WHERE pedido_id = $1 AND data_evento <= $2
    ORDER BY data_evento DESC, id DESC
    LIMIT 1
  `, [pedidoId, getHoje()]);

  return evento ? evento.status : 'Pedido confirmado';
}

async function calcularProgresso(pedidoId) {
  const totalRow = await dbGet(
    `SELECT COUNT(*)::int AS total FROM eventos WHERE pedido_id = $1`,
    [pedidoId]
  );
  const feitosRow = await dbGet(`
    SELECT COUNT(*)::int AS total
    FROM eventos
    WHERE pedido_id = $1 AND data_evento <= $2
  `, [pedidoId, getHoje()]);

  const total = totalRow ? totalRow.total : 0;
  const feitos = feitosRow ? feitosRow.total : 0;

  if (!total) return 0;
  return Math.round((feitos / total) * 100);
}

function calcularDiasRestantes(previsao) {
  if (!previsao) return 0;
  const hoje = parseDateOnly(getHoje());
  const entrega = parseDateOnly(previsao);
  const diff = entrega - hoje;
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

async function atualizarStatusPedido(pedidoId) {
  const status = await calcularStatusAtual(pedidoId);
  await dbRun(`UPDATE pedidos SET status_atual = $1 WHERE id = $2`, [status, pedidoId]);
  return status;
}

function renderBase(title, content) {
  return `
  <html>
  <head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>${title}</title>
    <style>
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: Arial, sans-serif;
        background: linear-gradient(135deg, #eef2ff 0%, #f8fafc 100%);
        color: #111827;
      }
      .page {
        min-height: 100vh;
        padding: 28px;
      }
      .container {
        max-width: 1100px;
        margin: 0 auto;
      }
      .card {
        background: rgba(255,255,255,0.96);
        border-radius: 24px;
        padding: 28px;
        box-shadow: 0 20px 60px rgba(17,24,39,0.08);
      }
      .button, button {
        display: inline-block;
        background: #2563eb;
        color: #fff;
        border: none;
        border-radius: 12px;
        padding: 12px 18px;
        text-decoration: none;
        cursor: pointer;
        font-weight: bold;
      }
      .button.dark { background: #111827; }
      .button.light {
        background: #eff6ff;
        color: #1d4ed8;
      }
      input, select, textarea {
        width: 100%;
        padding: 14px 16px;
        border: 1px solid #d1d5db;
        border-radius: 12px;
        font-size: 15px;
        outline: none;
        background: #fff;
      }
      input:focus, select:focus, textarea:focus {
        border-color: #2563eb;
        box-shadow: 0 0 0 4px rgba(37,99,235,0.10);
      }
      textarea {
        min-height: 100px;
        resize: vertical;
      }
      .grid {
        display: grid;
        gap: 16px;
      }
      .grid-2 { grid-template-columns: repeat(2, minmax(0,1fr)); }
      .grid-3 { grid-template-columns: repeat(3, minmax(0,1fr)); }
      .grid-4 { grid-template-columns: repeat(4, minmax(0,1fr)); }
      .muted { color: #6b7280; }
      .label {
        display: block;
        margin: 0 0 8px 0;
        color: #374151;
        font-weight: bold;
        font-size: 14px;
      }
      .table-wrap { overflow: auto; }
      table {
        width: 100%;
        border-collapse: collapse;
        min-width: 900px;
      }
      th, td {
        padding: 14px 12px;
        border-bottom: 1px solid #e5e7eb;
        text-align: left;
        vertical-align: top;
      }
      th {
        color: #374151;
        background: #f8fafc;
        font-size: 14px;
      }
      .badge {
        display: inline-block;
        padding: 8px 12px;
        border-radius: 999px;
        font-size: 12px;
        font-weight: bold;
        background: #eff6ff;
        color: #1d4ed8;
      }
      .topbar {
        display: flex;
        justify-content: space-between;
        align-items: center;
        gap: 12px;
        flex-wrap: wrap;
        margin-bottom: 20px;
      }
      .actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
      }
      .stat-grid {
        display: grid;
        grid-template-columns: repeat(4, minmax(0,1fr));
        gap: 14px;
        margin-bottom: 20px;
      }
      .stat {
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        border-radius: 18px;
        padding: 18px;
      }
      .stat .number {
        font-size: 28px;
        font-weight: bold;
        margin-top: 6px;
      }
      .hero {
        min-height: calc(100vh - 56px);
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .hero-card {
        max-width: 820px;
        width: 100%;
        text-align: center;
        padding: 46px 34px;
      }
      .hero-badge {
        display: inline-block;
        padding: 8px 14px;
        border-radius: 999px;
        background: #dbeafe;
        color: #1d4ed8;
        font-weight: bold;
        font-size: 13px;
        margin-bottom: 16px;
      }
      .hero h1 {
        font-size: 44px;
        margin: 0 0 12px 0;
      }
      .hero p {
        color: #6b7280;
        font-size: 18px;
        margin: 0 0 28px 0;
      }
      .search-form {
        display: flex;
        gap: 12px;
        flex-wrap: wrap;
        justify-content: center;
      }
      .search-form input {
        flex: 1;
        min-width: 280px;
        max-width: 460px;
      }
      .info-grid {
        display: grid;
        grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
        gap: 16px;
      }
      .info-item {
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        border-radius: 18px;
        padding: 18px;
      }
      .info-item .k {
        color: #6b7280;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: .4px;
        margin-bottom: 6px;
      }
      .info-item .v {
        font-size: 18px;
        font-weight: bold;
      }
      .status-box {
        margin-top: 18px;
        padding: 18px;
        border-radius: 18px;
        background: #eff6ff;
        border: 1px solid #bfdbfe;
      }
      .status-box .title {
        color: #6b7280;
        font-size: 13px;
        text-transform: uppercase;
        letter-spacing: .4px;
        margin-bottom: 6px;
      }
      .status-box .value {
        font-size: 24px;
        font-weight: bold;
      }
      .progress-wrap { margin-top: 22px; }
      .progress-head {
        display: flex;
        justify-content: space-between;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
        margin-bottom: 10px;
      }
      .progress-bar {
        width: 100%;
        height: 16px;
        background: #e5e7eb;
        border-radius: 999px;
        overflow: hidden;
      }
      .progress-fill {
        height: 100%;
        background: linear-gradient(90deg, #2563eb, #1d4ed8);
        border-radius: 999px;
      }
      .steps {
        display: grid;
        grid-template-columns: repeat(4, minmax(0,1fr));
        gap: 12px;
        margin-top: 14px;
      }
      .step {
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        border-radius: 14px;
        padding: 12px;
        text-align: center;
        font-size: 14px;
      }
      .event-list { margin-top: 10px; }
      .evento {
        display: flex;
        gap: 14px;
        position: relative;
        padding-bottom: 22px;
      }
      .evento:not(:last-child)::after {
        content: '';
        position: absolute;
        left: 8px;
        top: 18px;
        width: 2px;
        height: calc(100% - 4px);
        background: #d1d5db;
      }
      .dot {
        width: 18px;
        height: 18px;
        border-radius: 50%;
        background: #2563eb;
        margin-top: 4px;
        flex-shrink: 0;
      }
      .evento .status {
        font-size: 17px;
        font-weight: bold;
        margin-bottom: 4px;
      }
      .route {
        background: #f8fafc;
        border: 1px dashed #cbd5e1;
        border-radius: 18px;
        padding: 18px;
        margin-top: 18px;
      }
      .route-line {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 12px;
        flex-wrap: wrap;
        font-weight: bold;
      }
      .copy-box {
        display: flex;
        gap: 10px;
        align-items: center;
        flex-wrap: wrap;
        margin-top: 12px;
      }
      .copy-code {
        background: #f8fafc;
        border: 1px solid #e5e7eb;
        padding: 12px 14px;
        border-radius: 12px;
        font-weight: bold;
      }
      .note {
        background: #fffbeb;
        border: 1px solid #fde68a;
        color: #92400e;
        padding: 14px 16px;
        border-radius: 14px;
        margin-top: 18px;
      }
      .form-actions {
        display: flex;
        gap: 10px;
        flex-wrap: wrap;
        margin-top: 18px;
      }
      @media (max-width: 900px) {
        .grid-2, .grid-3, .grid-4, .steps, .stat-grid { grid-template-columns: 1fr 1fr; }
      }
      @media (max-width: 640px) {
        .page { padding: 16px; }
        .hero h1 { font-size: 32px; }
        .grid-2, .grid-3, .grid-4, .steps, .stat-grid { grid-template-columns: 1fr; }
        .search-form input, .search-form button { width: 100%; max-width: 100%; }
      }
    </style>
  </head>
  <body>
    <div class="page">
      <div class="container">
        ${content}
      </div>
    </div>
  </body>
  </html>
  `;
}

// ---------------- SITE PÚBLICO ----------------
app.get('/', (req, res) => {
  res.send(renderBase('Rastreamento', `
    <div class="hero">
      <div class="card hero-card">
        <div class="hero-badge">Acompanhe seu pedido</div>
        <h1>Rastreamento de pedido</h1>
        <p>Digite o código de rastreio para visualizar o andamento do seu pedido, previsão de entrega e linha do tempo.</p>
        <form class="search-form" action="/rastrear" method="GET">
          <input name="codigo" placeholder="Ex: AB123456789BR" required />
          <button type="submit">Rastrear</button>
        </form>
      </div>
    </div>
  `));
});

app.get('/rastrear', async (req, res) => {
  const codigo = req.query.codigo;
  const pedido = await dbGet(`SELECT * FROM pedidos WHERE codigo = $1`, [codigo]);

  if (!pedido) {
    return res.send(renderBase('Pedido não encontrado', `
      <div class="card" style="max-width:700px;margin:40px auto;text-align:center;">
        <h2>Código de rastreio não encontrado</h2>
        <p class="muted">Verifique se digitou corretamente e tente novamente.</p>
        <a class="button" href="/">Voltar para a busca</a>
      </div>
    `));
  }

  const statusAtual = await atualizarStatusPedido(pedido.id);
  const progresso = await calcularProgresso(pedido.id);
  const diasRestantes = calcularDiasRestantes(pedido.previsao_entrega);

  const eventosVisiveis = await dbAll(`
    SELECT * FROM eventos
    WHERE pedido_id = $1 AND data_evento <= $2
    ORDER BY data_evento DESC, id DESC
  `, [pedido.id, getHoje()]);

  const timelineHtml = eventosVisiveis.length
    ? eventosVisiveis.map(ev => `
        <div class="evento">
          <div class="dot"></div>
          <div>
            <div class="status">${escapeHtml(ev.status)}</div>
            <div class="muted">${escapeHtml(ev.local)}</div>
            <div class="muted">${formatarDataBR(ev.data_evento)}</div>
          </div>
        </div>
      `).join('')
    : '<p class="muted">Nenhum evento disponível ainda.</p>';

  const mensagemDinamica = statusAtual === 'Saiu para entrega'
    ? 'Seu pedido está em rota final e deve chegar em breve.'
    : diasRestantes > 1
      ? `Faltam aproximadamente ${diasRestantes} dias para a previsão de entrega.`
      : diasRestantes === 1
        ? 'A previsão indica entrega para amanhã.'
        : 'Seu pedido está em fase avançada de processamento.';

  res.send(renderBase('Resultado do rastreio', `
    <div class="topbar">
      <div>
        <div class="badge">Consulta realizada</div>
        <h1 style="margin:10px 0 0 0;">Acompanhamento do pedido</h1>
      </div>
      <div class="actions">
        <a class="button light" href="/">Nova busca</a>
      </div>
    </div>

    <div class="card" style="margin-bottom:20px;">
      <div class="info-grid">
        <div class="info-item"><div class="k">Cliente</div><div class="v">${escapeHtml(pedido.cliente || '-')}</div></div>
        <div class="info-item"><div class="k">Produto</div><div class="v">${escapeHtml(pedido.produto || '-')}</div></div>
        <div class="info-item"><div class="k">Peso</div><div class="v">${escapeHtml(pedido.peso || '-')}</div></div>
        <div class="info-item"><div class="k">Modalidade</div><div class="v">${escapeHtml(pedido.modalidade || '-')}</div></div>
        <div class="info-item"><div class="k">Origem</div><div class="v">${escapeHtml(pedido.origem || '-')}</div></div>
        <div class="info-item"><div class="k">Destino</div><div class="v">${escapeHtml(pedido.destino || '-')}</div></div>
        <div class="info-item"><div class="k">Previsão de entrega</div><div class="v">${formatarDataBR(pedido.previsao_entrega)}</div></div>
        <div class="info-item"><div class="k">Prazo estimado</div><div class="v">${escapeHtml(String(pedido.prazo_dias || '-'))} dias</div></div>
      </div>

      <div class="copy-box">
        <div class="copy-code" id="codigoPedido">${escapeHtml(pedido.codigo)}</div>
        <button type="button" onclick="navigator.clipboard.writeText(document.getElementById('codigoPedido').innerText)">Copiar código</button>
      </div>

      <div class="status-box">
        <div class="title">Status atual</div>
        <div class="value">${escapeHtml(statusAtual)}</div>
        <div class="muted" style="margin-top:6px;">${mensagemDinamica}</div>
      </div>

      <div class="progress-wrap">
        <div class="progress-head">
          <strong>Progresso da entrega</strong>
          <span>${progresso}% concluído</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${progresso}%;"></div>
        </div>
        <div class="steps">
          <div class="step">Pedido criado</div>
          <div class="step">Em processamento</div>
          <div class="step">Em transporte</div>
          <div class="step">Saiu para entrega</div>
        </div>
      </div>

      <div class="route">
        <div class="muted" style="text-align:center;margin-bottom:8px;">Rota do pedido</div>
        <div class="route-line">
          <span>${escapeHtml(pedido.origem)}</span>
          <span>→</span>
          <span>Centro de distribuição</span>
          <span>→</span>
          <span>${escapeHtml(pedido.destino)}</span>
        </div>
      </div>

      ${pedido.observacao ? `<div class="note"><strong>Informação adicional:</strong> ${escapeHtml(pedido.observacao)}</div>` : ''}
    </div>

    <div class="card">
      <h2 style="margin-top:0;">Linha do tempo</h2>
      <div class="event-list">${timelineHtml}</div>
    </div>
  `));
});

// ---------------- ADMIN LOGIN ----------------
app.get('/admin', (req, res) => {
  res.send(renderBase('Login admin', `
    <div style="max-width:420px;margin:60px auto;">
      <div class="card">
        <div class="badge">Área administrativa</div>
        <h2 style="margin-top:10px;">Entrar no painel</h2>
        <form method="POST" action="/admin">
          <label class="label">Usuário</label>
          <input name="user" placeholder="Digite o usuário" required />
          <label class="label" style="margin-top:14px;">Senha</label>
          <input name="pass" type="password" placeholder="Digite a senha" required />
          <div class="form-actions">
            <button type="submit">Entrar</button>
            <a class="button light" href="/">Voltar</a>
          </div>
        </form>
      </div>
    </div>
  `));
});

app.post('/admin', (req, res) => {
  const { user, pass } = req.body;
  if (user === ADMIN_USER && pass === ADMIN_PASS) {
    logged = true;
    return res.redirect('/admin/dashboard');
  }

  res.send(renderBase('Login inválido', `
    <div style="max-width:520px;margin:60px auto;">
      <div class="card" style="text-align:center;">
        <h2>Login inválido</h2>
        <p class="muted">Verifique usuário e senha.</p>
        <a class="button" href="/admin">Tentar novamente</a>
      </div>
    </div>
  `));
});

// ---------------- DASHBOARD ----------------
app.get('/admin/dashboard', async (req, res) => {
  if (!logged) return res.redirect('/admin');

  const pedidos = await dbAll(`SELECT * FROM pedidos ORDER BY id DESC`);

  let total = pedidos.length;
  let emTransito = 0;
  let saiuParaEntrega = 0;
  let criadosHoje = 0;
  const hoje = getHoje();

  const rowsArray = [];
  for (const p of pedidos) {
    const statusAtual = await atualizarStatusPedido(p.id);
    if (statusAtual === 'Em trânsito') emTransito++;
    if (statusAtual === 'Saiu para entrega') saiuParaEntrega++;
    if (p.created_at === hoje) criadosHoje++;

    rowsArray.push(`
      <tr>
        <td>${escapeHtml(p.codigo)}</td>
        <td>${escapeHtml(p.cliente || '-')}</td>
        <td>${escapeHtml(p.produto || '-')}</td>
        <td>${escapeHtml(p.origem || '-')}</td>
        <td>${escapeHtml(p.destino || '-')}</td>
        <td><span class="badge">${escapeHtml(statusAtual)}</span></td>
        <td>${formatarDataBR(p.previsao_entrega)}</td>
        <td>
          <div class="actions">
            <a class="button light" href="/admin/editar/${p.id}">Editar</a>
            <a class="button" href="/rastrear?codigo=${encodeURIComponent(p.codigo)}">Ver</a>
          </div>
        </td>
      </tr>
    `);
  }

  const rows = rowsArray.join('');

  res.send(renderBase('Painel admin', `
    <div class="topbar">
      <div>
        <div class="badge">Painel administrativo</div>
        <h1 style="margin:10px 0 0 0;">Pedidos cadastrados</h1>
      </div>
      <div class="actions">
        <a class="button dark" href="/admin/novo">Criar novo pedido</a>
        <a class="button light" href="/">Ver site público</a>
      </div>
    </div>

    <div class="stat-grid">
      <div class="stat"><div class="muted">Total de pedidos</div><div class="number">${total}</div></div>
      <div class="stat"><div class="muted">Criados hoje</div><div class="number">${criadosHoje}</div></div>
      <div class="stat"><div class="muted">Em trânsito</div><div class="number">${emTransito}</div></div>
      <div class="stat"><div class="muted">Saiu para entrega</div><div class="number">${saiuParaEntrega}</div></div>
    </div>

    <div class="card">
      <div class="table-wrap">
        <table>
          <tr>
            <th>Código</th>
            <th>Cliente</th>
            <th>Produto</th>
            <th>Origem</th>
            <th>Destino</th>
            <th>Status</th>
            <th>Previsão</th>
            <th>Ações</th>
          </tr>
          ${rows || '<tr><td colspan="8">Nenhum pedido cadastrado ainda.</td></tr>'}
        </table>
      </div>
    </div>
  `));
});

// ---------------- NOVO PEDIDO ----------------
app.get('/admin/novo', (req, res) => {
  if (!logged) return res.redirect('/admin');

  res.send(renderBase('Novo pedido', `
    <div style="max-width:860px;margin:0 auto;">
      <div class="topbar">
        <div>
          <div class="badge">Novo cadastro</div>
          <h1 style="margin:10px 0 0 0;">Criar novo rastreio</h1>
        </div>
        <a class="button light" href="/admin/dashboard">Voltar ao painel</a>
      </div>

      <div class="card">
        <form method="POST" action="/admin/novo">
          <div class="grid grid-2">
            <div>
              <label class="label">Nome do cliente</label>
              <input name="cliente" placeholder="Ex: João Silva" required />
            </div>
            <div>
              <label class="label">Produto</label>
              <input name="produto" placeholder="Ex: Smartwatch Series 8" required />
            </div>
            <div>
              <label class="label">Peso da encomenda</label>
              <input name="peso" placeholder="Ex: 1.2 kg" required />
            </div>
            <div>
              <label class="label">Modalidade de entrega</label>
              <select name="modalidade" required>
                <option value="">Selecione a modalidade</option>
                ${optionsModalidade()}
              </select>
            </div>
            <div>
              <label class="label">Estado de origem</label>
              <select name="origem" required>
                <option value="">Selecione o estado de origem</option>
                ${optionsEstados()}
              </select>
            </div>
            <div>
              <label class="label">Estado de destino</label>
              <select name="destino" required>
                <option value="">Selecione o estado de destino</option>
                ${optionsEstados()}
              </select>
            </div>
            <div>
              <label class="label">Prazo em dias</label>
              <input name="prazo" type="number" min="1" placeholder="Ex: 15" required />
            </div>
          </div>

          <div style="margin-top:16px;">
            <label class="label">Observação</label>
            <textarea name="observacao" placeholder="Informação complementar para exibição no acompanhamento."></textarea>
          </div>

          <div class="form-actions">
            <button type="submit">Criar rastreio</button>
            <a class="button light" href="/admin/dashboard">Cancelar</a>
          </div>
        </form>
      </div>
    </div>
  `));
});

app.post('/admin/novo', async (req, res) => {
  if (!logged) return res.redirect('/admin');

  const { cliente, produto, peso, origem, destino, modalidade, observacao, prazo } = req.body;
  const prazoNumero = Number(prazo);

  if (!cliente || !produto || !peso || !origem || !destino || !modalidade || !prazoNumero || prazoNumero < 1) {
    return res.send(renderBase('Erro', `
      <div style="max-width:700px;margin:60px auto;">
        <div class="card" style="text-align:center;">
          <h2>Preencha todos os campos corretamente</h2>
          <a class="button" href="/admin/novo">Voltar</a>
        </div>
      </div>
    `));
  }

  let codigo = gerarCodigo();
  while (await dbGet(`SELECT 1 FROM pedidos WHERE codigo = $1`, [codigo])) {
    codigo = gerarCodigo();
  }

  const timeline = gerarTimeline(prazoNumero, origem, destino);
  const previsaoEntrega = timeline[timeline.length - 1].data;
  const createdAt = getHoje();

  const result = await dbRun(`
    INSERT INTO pedidos (
      codigo, cliente, produto, peso, origem, destino, modalidade, observacao,
      prazo_dias, previsao_entrega, status_atual, created_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
    RETURNING id
  `, [
    codigo, cliente, produto, peso, origem, destino, modalidade, observacao || '',
    prazoNumero, previsaoEntrega, timeline[0].status, createdAt
  ]);

  const pedidoId = result.rows[0].id;

  for (const evento of timeline) {
    await dbRun(`
      INSERT INTO eventos (pedido_id, status, local, data_evento)
      VALUES ($1, $2, $3, $4)
    `, [pedidoId, evento.status, evento.local, evento.data]);
  }

  res.send(renderBase('Rastreio criado', `
    <div style="max-width:760px;margin:60px auto;">
      <div class="card">
        <div class="badge">Cadastro concluído</div>
        <h2>Rastreio criado com sucesso</h2>
        <div class="info-grid" style="margin-top:18px;">
          <div class="info-item"><div class="k">Código</div><div class="v">${escapeHtml(codigo)}</div></div>
          <div class="info-item"><div class="k">Previsão de entrega</div><div class="v">${formatarDataBR(previsaoEntrega)}</div></div>
        </div>
        <div class="form-actions">
          <a class="button dark" href="/admin/dashboard">Voltar ao painel</a>
          <a class="button" href="/rastrear?codigo=${encodeURIComponent(codigo)}">Ver rastreio público</a>
        </div>
      </div>
    </div>
  `));
});

// ---------------- EDITAR PEDIDO ----------------
app.get('/admin/editar/:id', async (req, res) => {
  if (!logged) return res.redirect('/admin');

  const pedido = await dbGet(`SELECT * FROM pedidos WHERE id = $1`, [req.params.id]);
  if (!pedido) return res.redirect('/admin/dashboard');

  const eventos = await dbAll(`SELECT * FROM eventos WHERE pedido_id = $1 ORDER BY data_evento ASC, id ASC`, [req.params.id]);

  const eventosHtml = eventos.map(ev => `
    <tr>
      <td>${escapeHtml(ev.status)}</td>
      <td>${escapeHtml(ev.local)}</td>
      <td>${formatarDataBR(ev.data_evento)}</td>
    </tr>
  `).join('');

  res.send(renderBase('Editar pedido', `
    <div style="max-width:980px;margin:0 auto;">
      <div class="topbar">
        <div>
          <div class="badge">Edição de pedido</div>
          <h1 style="margin:10px 0 0 0;">Editar cadastro</h1>
        </div>
        <a class="button light" href="/admin/dashboard">Voltar ao painel</a>
      </div>

      <div class="card" style="margin-bottom:20px;">
        <form method="POST" action="/admin/editar/${pedido.id}">
          <div class="grid grid-2">
            <div>
              <label class="label">Nome do cliente</label>
              <input name="cliente" value="${escapeHtml(pedido.cliente || '')}" required />
            </div>
            <div>
              <label class="label">Produto</label>
              <input name="produto" value="${escapeHtml(pedido.produto || '')}" required />
            </div>
            <div>
              <label class="label">Peso</label>
              <input name="peso" value="${escapeHtml(pedido.peso || '')}" required />
            </div>
            <div>
              <label class="label">Modalidade</label>
              <select name="modalidade" required>
                ${optionsModalidade(pedido.modalidade)}
              </select>
            </div>
            <div>
              <label class="label">Origem</label>
              <select name="origem" required>
                ${optionsEstados(pedido.origem)}
              </select>
            </div>
            <div>
              <label class="label">Destino</label>
              <select name="destino" required>
                ${optionsEstados(pedido.destino)}
              </select>
            </div>
            <div>
              <label class="label">Prazo em dias</label>
              <input name="prazo_dias" type="number" min="1" value="${escapeHtml(String(pedido.prazo_dias || 1))}" required />
            </div>
            <div>
              <label class="label">Previsão de entrega</label>
              <input name="previsao_entrega" value="${escapeHtml(pedido.previsao_entrega || '')}" readonly />
            </div>
          </div>

          <div style="margin-top:16px;">
            <label class="label">Observação</label>
            <textarea name="observacao">${escapeHtml(pedido.observacao || '')}</textarea>
          </div>

          <div class="form-actions">
            <button type="submit">Salvar alterações</button>
            <a class="button light" href="/rastrear?codigo=${encodeURIComponent(pedido.codigo)}">Ver rastreio</a>
          </div>
        </form>
      </div>

      <div class="card">
        <h2 style="margin-top:0;">Linha do tempo cadastrada</h2>
        <div class="table-wrap">
          <table>
            <tr>
              <th>Status</th>
              <th>Local</th>
              <th>Data</th>
            </tr>
            ${eventosHtml || '<tr><td colspan="3">Nenhum evento cadastrado.</td></tr>'}
          </table>
        </div>
      </div>
    </div>
  `));
});

app.post('/admin/editar/:id', async (req, res) => {
  if (!logged) return res.redirect('/admin');

  const { cliente, produto, peso, origem, destino, modalidade, observacao, prazo_dias } = req.body;
  const pedido = await dbGet(`SELECT * FROM pedidos WHERE id = $1`, [req.params.id]);
  if (!pedido) return res.redirect('/admin/dashboard');

  const prazoNumero = Number(prazo_dias);
  const previsaoRow = await dbGet(`SELECT MAX(data_evento) AS data FROM eventos WHERE pedido_id = $1`, [req.params.id]);
  const previsao = previsaoRow ? previsaoRow.data : null;

  await dbRun(`
    UPDATE pedidos
    SET cliente = $1, produto = $2, peso = $3, origem = $4, destino = $5, modalidade = $6, observacao = $7, prazo_dias = $8, previsao_entrega = $9
    WHERE id = $10
  `, [
    cliente, produto, peso, origem, destino, modalidade, observacao || '', prazoNumero, previsao, req.params.id
  ]);

  res.redirect('/admin/dashboard');
});

initDB().then(() => {
  app.listen(process.env.PORT || 3000, () => {
    console.log('Servidor rodando');
  });
});
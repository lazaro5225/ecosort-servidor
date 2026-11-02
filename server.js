const express = require('express');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAVE = process.env.CLAVE_API || 'eco';
const ARCHIVO = path.join(__dirname, 'datos.json');

app.use(express.json());

// ---------- Protección opcional del panel ----------
const PANEL_USUARIO = process.env.PANEL_USUARIO || 'admin';
const PANEL_CLAVE = process.env.PANEL_CLAVE;
app.use((req, res, next) => {
  if (!PANEL_CLAVE || req.path === '/api/datos' || req.path === '/api/comando') return next();
  const d = Buffer.from((req.get('authorization') || '').replace('Basic ', ''), 'base64').toString();
  const i = d.indexOf(':');
  if (i >= 0 && d.slice(0, i) === PANEL_USUARIO && d.slice(i + 1) === PANEL_CLAVE) return next();
  res.set('WWW-Authenticate', 'Basic realm="ECO-SORT"').status(401).send('Acceso restringido');
});

// ---------- Archivos del panel ----------
const carpetaPublica = path.join(__dirname, 'public');
if (fs.existsSync(path.join(carpetaPublica, 'index.html'))) {
  app.use(express.static(carpetaPublica));
} else if (fs.existsSync(path.join(__dirname, 'index.html'))) {
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
} else {
  app.get('/', (req, res) => res.status(500).send('Falta index.html en el repositorio.'));
}

// ---------- Estado en memoria ----------
let db = { pausa: false, cerrarCompuerta: false, ultimaConexion: 0, niveles: [0, 0, 0], contadores: [0, 0, 0], lleno: null, eventos: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'))); } catch (e) {}

// ---------- Base de datos (Neon / PostgreSQL) ----------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const errBD = e => console.error('Error BD:', e.message);

async function iniciarBD() {
  if (!pool) {
    console.log('Sin DATABASE_URL: se usa solo datos.json');
    return;
  }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS estado (
      id INT PRIMARY KEY,
      pausa BOOLEAN NOT NULL DEFAULT false,
      niveles JSONB NOT NULL,
      contadores JSONB NOT NULL,
      lleno TEXT
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS eventos (
      id SERIAL PRIMARY KEY,
      fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
      evento TEXT NOT NULL,
      categoria TEXT,
      inductivo BOOLEAN,
      capacitivo BOOLEAN
    )`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS lecturas (
      id SERIAL PRIMARY KEY,
      fecha TIMESTAMPTZ NOT NULL DEFAULT now(),
      nivel_metal INT,
      nivel_organico INT,
      nivel_variado INT,
      cont_metal INT,
      cont_organico INT,
      cont_variado INT
    )`);

  await pool.query('ALTER TABLE estado ADD COLUMN IF NOT EXISTS cerrar_compuerta BOOLEAN NOT NULL DEFAULT false');

  // Recuperar el último estado guardado
  const est = await pool.query('SELECT * FROM estado WHERE id = 1');
  if (est.rows[0]) {
    const r = est.rows[0];
    db.pausa = r.pausa;
    db.cerrarCompuerta = !!r.cerrar_compuerta;
    db.niveles = r.niveles;
    db.contadores = r.contadores;
    db.lleno = r.lleno || null;
  }
  const ev = await pool.query(
    'SELECT fecha, evento, categoria, inductivo, capacitivo FROM eventos ORDER BY fecha DESC LIMIT 200'
  );
  db.eventos = ev.rows.map(r => ({
    fecha: r.fecha.toISOString(),
    evento: r.evento,
    categoria: r.categoria || '',
    inductivo: r.inductivo,
    capacitivo: r.capacitivo
  }));
  console.log('Base de datos lista. Contadores recuperados:', db.contadores);
}

function guardarEstadoBD() {
  if (!pool) return;
  pool.query(
    `INSERT INTO estado (id, pausa, niveles, contadores, lleno, cerrar_compuerta)
     VALUES (1, $1, $2, $3, $4, $5)
     ON CONFLICT (id) DO UPDATE
     SET pausa = $1, niveles = $2, contadores = $3, lleno = $4, cerrar_compuerta = $5`,
    [db.pausa, JSON.stringify(db.niveles), JSON.stringify(db.contadores), db.lleno, db.cerrarCompuerta]
  ).catch(errBD);
}

function guardarLecturaBD() {
  if (!pool) return;
  pool.query(
    `INSERT INTO lecturas
     (nivel_metal, nivel_organico, nivel_variado, cont_metal, cont_organico, cont_variado)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [...db.niveles, ...db.contadores]
  ).catch(errBD);
}

function guardarEventoBD(e) {
  if (!pool) return;
  pool.query(
    `INSERT INTO eventos (evento, categoria, inductivo, capacitivo) VALUES ($1, $2, $3, $4)`,
    [e.evento, e.categoria, e.inductivo, e.capacitivo]
  ).catch(errBD);
}

const guardar = () => {
  fs.writeFile(ARCHIVO, JSON.stringify(db), () => {});
  guardarEstadoBD();
};

// ---------- API ----------
const auth = (req, res, next) =>
  req.get('x-clave') === CLAVE ? next() : res.status(401).json({ error: 'clave incorrecta' });
const num3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

app.post('/api/datos', auth, (req, res) => {
  const b = req.body || {};
  if (num3(b.niveles)) db.niveles = b.niveles;
  if (num3(b.contadores)) db.contadores = b.contadores;
  db.lleno = b.lleno || null;
  db.ultimaConexion = Date.now();

  guardarLecturaBD();

  if (b.evento && b.evento !== 'niveles') {
    const e = {
      fecha: new Date().toISOString(), evento: b.evento, categoria: b.categoria || '',
      inductivo: !!b.inductivo, capacitivo: !!b.capacitivo
    };
    db.eventos.unshift(e);
    db.eventos = db.eventos.slice(0, 200);
    guardarEventoBD(e);
  }
  guardar();
  res.json({ pausa: db.pausa, cerrarCompuerta: db.cerrarCompuerta });
});

app.get('/api/comando', auth, (req, res) => {
  db.ultimaConexion = Date.now();
  res.json({ pausa: db.pausa, cerrarCompuerta: db.cerrarCompuerta });
});

app.get('/api/estado', (req, res) =>
  res.json(Object.assign({}, db, { conectado: Date.now() - db.ultimaConexion < 25000 })));

app.post('/api/pausa', (req, res) => {
  db.pausa = !!(req.body && req.body.pausa);
  guardar();
  res.json({ pausa: db.pausa });
});

// Cerrar / abrir manualmente la compuerta de entrada (servo)
app.post('/api/compuerta', (req, res) => {
  db.cerrarCompuerta = !!(req.body && req.body.cerrar);
  const e = {
    fecha: new Date().toISOString(),
    evento: db.cerrarCompuerta ? 'compuerta_cerrada' : 'compuerta_abierta',
    categoria: '', inductivo: false, capacitivo: false
  };
  db.eventos.unshift(e);
  db.eventos = db.eventos.slice(0, 200);
  guardarEventoBD(e);
  guardar();
  res.json({ cerrarCompuerta: db.cerrarCompuerta });
});

// Historial de lecturas (para gráficas futuras)
app.get('/api/historial', async (req, res) => {
  if (!pool) return res.json([]);
  try {
    const r = await pool.query(
      `SELECT fecha, nivel_metal, nivel_organico, nivel_variado
       FROM lecturas ORDER BY fecha DESC LIMIT 500`
    );
    res.json(r.rows);
  } catch (e) {
    errBD(e);
    res.status(500).json({ error: 'error de base de datos' });
  }
});

// ---------- Arranque ----------
iniciarBD()
  .catch(errBD)
  .finally(() => {
    app.listen(PORT, '0.0.0.0', () => console.log('ECO-SORT ULS en puerto ' + PORT));
  });

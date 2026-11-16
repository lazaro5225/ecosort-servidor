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
// Define PANEL_CLAVE (y opcionalmente PANEL_USUARIO) en Render para proteger el panel.
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
let db = {
  pausa: false,
  cerrarCompuerta: false,
  ultimaConexion: 0,
  niveles: [0, 0, 0],
  contadores: [0, 0, 0],
  lleno: null,
  llenos: [false, false, false],
  confirmaciones: [0, 0, 0],
  eventos: []
};
try { db = Object.assign(db, JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'))); } catch (e) {}

// Orden de "activar banda" pendiente de entregar al Arduino (solo en memoria, no se repite al reiniciar)
let ordenBanda = false;
// Ciclo de deteccion en curso (para la cuenta regresiva del panel)
let ciclo = null;
let ultimaLectura = 0;

// ---------- Base de datos (Neon / PostgreSQL) ----------
const pool = process.env.DATABASE_URL
  ? new Pool({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } })
  : null;

const errBD = e => console.error('Error BD:', e.message);
if (pool) pool.on('error', errBD);

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

  // Limpieza: conservar solo 7 días de lecturas
  pool.query("DELETE FROM lecturas WHERE fecha < now() - interval '7 days'").catch(errBD);
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
  // Máximo una lectura por minuto para no llenar la base de datos
  if (Date.now() - ultimaLectura < 60000) return;
  ultimaLectura = Date.now();
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

function registrarEvento(evento, categoria, inductivo, capacitivo) {
  const e = {
    fecha: new Date().toISOString(), evento, categoria: categoria || '',
    inductivo: !!inductivo, capacitivo: !!capacitivo
  };
  db.eventos.unshift(e);
  db.eventos = db.eventos.slice(0, 200);
  guardarEventoBD(e);
}

// ---------- API ----------
const auth = (req, res, next) =>
  req.get('x-clave') === CLAVE ? next() : res.status(401).json({ error: 'clave incorrecta' });
const num3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const bool3 = a => Array.isArray(a) && a.length === 3 && a.every(x => typeof x === 'boolean');
const int3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isInteger);

// Respuesta de comandos para el Arduino. La orden de banda se entrega una sola vez.
function comandos() {
  const r = { pausa: db.pausa, cerrarCompuerta: db.cerrarCompuerta, banda: ordenBanda };
  ordenBanda = false;
  return r;
}

app.post('/api/datos', auth, (req, res) => {
  const b = req.body || {};
  if (num3(b.niveles)) db.niveles = b.niveles;
  if (num3(b.contadores)) db.contadores = b.contadores;
  if (bool3(b.llenos)) db.llenos = b.llenos;
  if (int3(b.confirmaciones)) db.confirmaciones = b.confirmaciones;
  if (b.lleno !== undefined) db.lleno = b.lleno || null;
  db.ultimaConexion = Date.now();

  guardarLecturaBD();

  if (b.evento === 'ciclo') {
    const dur = Number.isFinite(b.duracion) && b.duracion > 0 ? b.duracion : 18000;
    ciclo = { fin: Date.now() + dur, dur, manual: !!b.manual };
  } else {
    ciclo = null;
  }

  if (b.evento && b.evento !== 'niveles' && b.evento !== 'ciclo') {
    registrarEvento(b.evento, b.categoria, b.inductivo, b.capacitivo);
  }
  guardar();
  res.json(comandos());
});

app.get('/api/comando', auth, (req, res) => {
  db.ultimaConexion = Date.now();
  res.json(comandos());
});

app.get('/api/estado', (req, res) =>
  res.json(Object.assign({}, db, {
    conectado: Date.now() - db.ultimaConexion < 25000,
    bandaPendiente: ordenBanda,
    ciclo: (ciclo && Date.now() < ciclo.fin + 15000)
      ? { restanteMs: Math.max(0, ciclo.fin - Date.now()), totalMs: ciclo.dur, manual: ciclo.manual }
      : null
  })));

app.post('/api/pausa', (req, res) => {
  db.pausa = !!(req.body && req.body.pausa);
  guardar();
  res.json({ pausa: db.pausa });
});

// Activar la banda manualmente (un ciclo completo, sin clasificar)
app.post('/api/banda', (req, res) => {
  if (db.lleno) return res.status(409).json({ error: 'Recipiente lleno. Vacíalo primero.' });
  ordenBanda = true;
  registrarEvento('banda_manual_orden', '', false, false);
  guardar();
  res.json({ ok: true, pendiente: true });
});

// Cerrar / abrir manualmente la compuerta de entrada (servo)
app.post('/api/compuerta', (req, res) => {
  db.cerrarCompuerta = !!(req.body && req.body.cerrar);
  registrarEvento(db.cerrarCompuerta ? 'compuerta_cerrada' : 'compuerta_abierta', '', false, false);
  guardar();
  res.json({ cerrarCompuerta: db.cerrarCompuerta });
});

// Historial de lecturas
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

const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAVE = process.env.CLAVE_API || 'eco-sort';
const ARCHIVO = path.join(__dirname, 'datos.json');

app.use(express.json());
// Contraseña del panel (solo si defines PANEL_CLAVE). El Arduino usa x-clave y no se ve afectado.
const PANEL_USUARIO = process.env.PANEL_USUARIO || 'admin';
const PANEL_CLAVE = process.env.PANEL_CLAVE;
app.use((req, res, next) => {
  if (!PANEL_CLAVE || req.path === '/api/datos' || req.path === '/api/comando') return next();
  const d = Buffer.from((req.get('authorization') || '').replace('Basic ', ''), 'base64').toString();
  const i = d.indexOf(':');
  if (i >= 0 && d.slice(0, i) === PANEL_USUARIO && d.slice(i + 1) === PANEL_CLAVE) return next();
  res.set('WWW-Authenticate', 'Basic realm="ECO-SORT"').status(401).send('Acceso restringido');
});
// Panel: busca index.html en /public o, si se subio suelto, en la raiz del repositorio.
const carpetaPublica = path.join(__dirname, 'public');
if (fs.existsSync(path.join(carpetaPublica, 'index.html'))) {
  app.use(express.static(carpetaPublica));
} else if (fs.existsSync(path.join(__dirname, 'index.html'))) {
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
} else {
  app.get('/', (req, res) => res.status(500).send('Falta index.html: debe estar en la carpeta public/ del repositorio.'));
}

let db = { pausa: false, ultimaConexion: 0, niveles: [0, 0, 0], contadores: [0, 0, 0], lleno: null, eventos: [] };
try { db = Object.assign(db, JSON.parse(fs.readFileSync(ARCHIVO, 'utf8'))); } catch (e) {}
const guardar = () => fs.writeFile(ARCHIVO, JSON.stringify(db), () => {});

const auth = (req, res, next) =>
  req.get('x-clave') === CLAVE ? next() : res.status(401).json({ error: 'clave incorrecta' });
const num3 = a => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);

// Arduino -> servidor
app.post('/api/datos', auth, (req, res) => {
  const b = req.body || {};
  if (num3(b.niveles)) db.niveles = b.niveles;
  if (num3(b.contadores)) db.contadores = b.contadores;
  db.lleno = b.lleno || null;
  db.ultimaConexion = Date.now();
  if (b.evento && b.evento !== 'niveles') {
    db.eventos.unshift({
      fecha: new Date().toISOString(), evento: b.evento, categoria: b.categoria || '',
      inductivo: !!b.inductivo, capacitivo: !!b.capacitivo
    });
    db.eventos = db.eventos.slice(0, 200);
  }
  guardar();
  res.json({ pausa: db.pausa });
});

// Arduino consulta la orden de pausa
app.get('/api/comando', auth, (req, res) => {
  db.ultimaConexion = Date.now();
  res.json({ pausa: db.pausa });
});

// Panel web
app.get('/api/estado', (req, res) =>
  res.json(Object.assign({}, db, { conectado: Date.now() - db.ultimaConexion < 25000 })));

app.post('/api/pausa', (req, res) => {
  db.pausa = !!(req.body && req.body.pausa);
  guardar();
  res.json({ pausa: db.pausa });
});

app.listen(PORT, '0.0.0.0', () => console.log('ECO-SORT ULS en http://localhost:' + PORT));

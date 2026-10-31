const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const CLAVE = process.env.CLAVE_API || 'ecosort-uls';
const ARCHIVO = path.join(__dirname, 'datos.json');

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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

const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const PORT = process.env.PORT || 3000;

const app = express();

// Cartella statica
app.use(express.static("public"));
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("votes.db");

// Numero di token da generare
const PARTICIPANTI = 300;

// --- Creazione tabelle e token ---
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS votes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT,
      choice TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY,
      used INTEGER DEFAULT 0
    )
  `);

  // Genera token solo se la tabella è vuota
  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (err) return console.error(err);
    if (row.count === 0) {
      for (let i = 0; i < PARTICIPANTI; i++) {
        const token = uuidv4();
        db.run("INSERT INTO tokens(token) VALUES(?)", [token]);
      }
      console.log(`${PARTICIPANTI} token generati sul server!`);
    }
  });
});

// --- ROTTE ---

// "/" → mostra vote.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// Votazione con token (funziona anche con più progetti per token)
app.post("/vote", (req, res) => {
  const { token, choice } = req.body;

  db.get("SELECT * FROM tokens WHERE token=?", [token], (err, row) => {
    if (err) return res.json({ error: "Errore server" });
    if (!row) return res.json({ error: "Token non valido" });
    if (row.used === 1) return res.json({ error: "Token già usato" });

    // Inserisce il voto per il progetto selezionato
    db.run("INSERT INTO votes(token, choice) VALUES(?,?)", [token, choice], (err) => {
      if (err) return res.json({ error: "Errore server" });

      // Segna il token come usato
      db.run("UPDATE tokens SET used=1 WHERE token=?", [token]);

      res.json({ success: true });
    });
  });
});

// Lista risultati
app.get("/results", (req, res) => {
  db.all("SELECT choice, COUNT(*) as votes FROM votes GROUP BY choice", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// Lista token (solo per debug/admin)
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// Admin.html
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Avvio server
app.listen(PORT, () => {
  console.log(`Server attivo su porta ${PORT}`);
});
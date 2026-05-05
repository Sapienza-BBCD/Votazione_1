const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// CONFIG
// =========================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "lab2go";
const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";

const PARTICIPANTI = 300;
const MAX_VOTES = 2;

// =========================
// MIDDLEWARE
// =========================
app.use(express.static("public"));
app.use(express.json());
app.use(cors());

// =========================
// DB
// =========================
const db = new sqlite3.Database("votes.db");

// =========================
// INIT DATABASE
// =========================
db.serialize(() => {

  db.run(`
    CREATE TABLE IF NOT EXISTS votes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT,
      percorso TEXT,
      scuola TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // stato iniziale
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    if (!row) {
      db.run("INSERT INTO settings(key,value) VALUES('stato','pre')");
    }
  });

  // genera token SOLO se non esistono
  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO tokens(token) VALUES(?)");
      for (let i = 0; i < PARTICIPANTI; i++) {
        stmt.run(uuidv4());
      }
      stmt.finalize();
      console.log("Token generati:", PARTICIPANTI);
    }
  });

});

// =========================
// HELPERS STATO
// =========================
function getStato(cb) {
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    cb(row ? row.value : "pre");
  });
}

function setStato(val, cb) {
  db.run("UPDATE settings SET value=? WHERE key='stato'", [val], cb);
}

// =========================
// ROUTES BASE
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

// =========================
// ADMIN LOGIN (semplice)
// =========================
app.post("/admin-login", (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.json({ error: "Password errata" });
  }

  res.json({ success: true });
});

// =========================
// VOTAZIONE
// =========================
app.post("/vote", (req, res) => {

  const { token, percorso, scuola } = req.body;

  getStato((stato) => {

    if (stato === "pre") return res.json({ error: "Votazione non aperta" });
    if (stato === "closed") return res.json({ error: "Votazione chiusa" });

    db.get("SELECT * FROM tokens WHERE token=?", [token], (err, row) => {

      if (!row) return res.json({ error: "Token non valido" });

      db.get(
        "SELECT COUNT(*) as count FROM votes WHERE token=?",
        [token],
        (err, result) => {

          if (result.count >= MAX_VOTES) {
            return res.json({ error: "Limite voti raggiunto" });
          }

          db.run(
            "INSERT INTO votes(token,percorso,scuola) VALUES(?,?,?)",
            [token, percorso, scuola],
            () => res.json({ success: true })
          );

        }
      );

    });

  });

});

// =========================
// STATO VOTAZIONE
// =========================
app.get("/admin/open", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.json({ error: "No" });
  setStato("open", () => res.json({ ok: true }));
});

app.get("/admin/close", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.json({ error: "No" });
  setStato("closed", () => res.json({ ok: true }));
});

app.get("/admin/reset", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.json({ error: "No" });
  setStato("pre", () => res.json({ ok: true }));
});

// reset voti
app.get("/admin/reset-votes", (req, res) => {
  if (req.query.password !== ADMIN_PASSWORD) return res.json({ error: "No" });
  db.run("DELETE FROM votes", () => res.json({ ok: true }));
});

// rigenera QR (NUOVA SESSIONE)
app.get("/admin/regenerate-tokens", (req, res) => {

  if (req.query.password !== ADMIN_PASSWORD) return res.json({ error: "No" });

  db.run("DELETE FROM tokens", () => {

    const stmt = db.prepare("INSERT INTO tokens(token) VALUES(?)");

    for (let i = 0; i < PARTICIPANTI; i++) {
      stmt.run(uuidv4());
    }

    stmt.finalize(() => {
      res.json({ ok: true });
    });

  });

});

// stato pubblico
app.get("/state", (req, res) => {
  getStato((stato) => res.json({ stato }));
});

// risultati
app.get("/results-data", (req, res) => {

  db.all(`
    SELECT percorso, scuola, COUNT(*) as votes
    FROM votes
    GROUP BY percorso, scuola
    ORDER BY percorso, votes DESC
  `, (err, rows) => {

    db.get("SELECT COUNT(*) as totale FROM votes", (err2, tot) => {

      res.json({
        totale: tot?.totale || 0,
        risultati: rows
      });

    });

  });

});

// tokens
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    res.json(rows);
  });
});

// =========================
// DOWNLOAD QR ZIP
// =========================
app.get("/download-qrs", async (req, res) => {

  res.attachment("qrcodes.zip");
  const archive = archiver("zip");
  archive.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    for (let i = 0; i < rows.length; i++) {
      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toBuffer(url);
      archive.append(qr, { name: `qr-${i + 1}.png` });
    }

    archive.finalize();
  });

});

// =========================
// PDF QR (FIX GRIGLIA PERFETTA)
// =========================
app.get("/print-qrs", async (req, res) => {

  const doc = new PDFDocument({ margin: 30 });

  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    const perRow = 3;
    const size = 120;
    const padding = 60;

    let col = 0;
    let row = 0;

    for (let i = 0; i < rows.length; i++) {

      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toDataURL(url);
      const img = Buffer.from(qr.split(",")[1], "base64");

      const x = 50 + col * (size + padding);
      const y = 50 + row * (size + 70);

      doc.image(img, x, y, { width: size });
      doc.text(`QR ${i + 1}`, x, y + size + 5, { width: size, align: "center" });

      col++;

      if (col === perRow) {
        col = 0;
        row++;
      }

      if (row === 4) {
        doc.addPage();
        row = 0;
      }

    }

    doc.end();

  });

});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

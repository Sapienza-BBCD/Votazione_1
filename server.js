const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const archiver = require("archiver");

const PORT = process.env.PORT || 3000;
const app = express();

// =========================
// CONFIG SICUREZZA
// =========================
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "lab2go";
const ADMIN_KEY = process.env.ADMIN_KEY || "change-me-very-secret";

const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";

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

const PARTICIPANTI = 300;
const MAX_VOTES = 2;

// =========================
// INIT DB
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

  // stato persistente
  db.run(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (!row || row.count === 0) {
      for (let i = 0; i < PARTICIPANTI; i++) {
        db.run("INSERT INTO tokens(token) VALUES(?)", [uuidv4()]);
      }
      console.log("Token generati:", PARTICIPANTI);
    }
  });

  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    if (!row) {
      db.run("INSERT INTO settings(key,value) VALUES('stato','pre')");
    }
  });

});

// =========================
// HELPER STATO
// =========================
function getStato(callback) {
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    callback(row ? row.value : "pre");
  });
}

function setStato(stato, cb) {
  db.run(
    "UPDATE settings SET value=? WHERE key='stato'",
    [stato],
    cb
  );
}

// =========================
// MIDDLEWARE ADMIN SECURITY
// =========================
function checkAdmin(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (key !== ADMIN_KEY) {
    return res.status(403).json({ error: "Forbidden" });
  }
  next();
}

// =========================
// ROUTES
// =========================

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// -------------------------
// VOTO
// -------------------------
app.post("/vote", (req, res) => {

  const { token, percorso, scuola } = req.body;

  getStato((stato) => {

    if (stato === "pre") {
      return res.json({ error: "Votazione non aperta" });
    }

    if (stato === "closed") {
      return res.json({ error: "Votazione chiusa" });
    }

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
            "INSERT INTO votes(token, percorso, scuola) VALUES(?,?,?)",
            [token, percorso, scuola],
            () => res.json({ success: true })
          );

        }
      );

    });

  });

});

// -------------------------
// ADMIN PAGE
// -------------------------
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

// LOGIN ADMIN
app.post("/admin-login", (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.json({ error: "Password errata" });
  }

  res.json({ success: true });
});

// -------------------------
// STATO VOTAZIONE (ROBUSTO)
// -------------------------
app.get("/admin/open", checkAdmin, (req, res) => {
  setStato("open", () => res.json({ ok: true, stato: "open" }));
});

app.get("/admin/close", checkAdmin, (req, res) => {
  setStato("closed", () => res.json({ ok: true, stato: "closed" }));
});

app.get("/admin/reset", checkAdmin, (req, res) => {
  setStato("pre", () => res.json({ ok: true, stato: "pre" }));
});

app.get("/state", (req, res) => {
  getStato((stato) => res.json({ stato }));
});

// -------------------------
// RESET VOTI
// -------------------------
app.get("/admin/reset-votes", checkAdmin, (req, res) => {
  db.run("DELETE FROM votes", () => {
    res.json({ ok: true });
  });
});

// -------------------------
// RISULTATI
// -------------------------
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

// -------------------------
// TOKEN
// -------------------------
app.get("/tokens", checkAdmin, (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    res.json(rows);
  });
});

// -------------------------
// QR ZIP
// -------------------------
app.get("/download-qrs", checkAdmin, (req, res) => {

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

// -------------------------
// PDF QR
// -------------------------
app.get("/print-qrs", checkAdmin, (req, res) => {

  const doc = new PDFDocument({ margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    let x = 50, y = 50;

    for (let i = 0; i < rows.length; i++) {

      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toDataURL(url);
      const img = Buffer.from(qr.split(",")[1], "base64");

      doc.image(img, x, y, { width: 100 });
      doc.text(`QR ${i + 1}`, x, y + 110);

      x += 150;
      if (x > 400) {
        x = 50;
        y += 150;
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

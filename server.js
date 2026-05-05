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
// MIDDLEWARE (IMPORTANTE ORDINE CORRETTO)
// =========================
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// =========================
// DATABASE
// =========================
const db = new sqlite3.Database("votes.db");

const PARTICIPANTI = 300;
const MAX_VOTES = 2;
const ADMIN_PASSWORD = "lab2go";

let statoVotazione = "pre";

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

  // genera token solo se vuoto
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
// HOME
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// =========================
// ADMIN PAGE
// =========================
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

// =========================
// LOGIN ADMIN
// =========================
app.post("/admin-login", (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.json({ error: "Password errata" });
  }

  res.json({ success: true });
});

// =========================
// STATO VOTAZIONE (FIX: ORA RESTITUISCE JSON)
// =========================
app.get("/open-vote", (req, res) => {
  statoVotazione = "open";
  res.json({ ok: true, stato: statoVotazione });
});

app.get("/close-vote", (req, res) => {
  statoVotazione = "closed";
  res.json({ ok: true, stato: statoVotazione });
});

app.get("/reset-vote", (req, res) => {
  statoVotazione = "pre";
  res.json({ ok: true, stato: statoVotazione });
});

// =========================
// RESET VOTI
// =========================
app.get("/reset-votes", (req, res) => {
  db.run("DELETE FROM votes", () => {
    res.json({ ok: true });
  });
});

// =========================
// VOTO
// =========================
app.post("/vote", (req, res) => {

  const { token, percorso, scuola } = req.body;

  if (statoVotazione === "pre") {
    return res.json({ error: "Votazione non aperta" });
  }

  if (statoVotazione === "closed") {
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
          "INSERT INTO votes(token,percorso,scuola) VALUES(?,?,?)",
          [token, percorso, scuola],
          () => res.json({ success: true })
        );

      }
    );

  });

});

// =========================
// RISULTATI
// =========================
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

// =========================
// TOKEN
// =========================
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    res.json(rows);
  });
});

// =========================
// DOWNLOAD QR
// =========================
app.get("/download-qrs", async (req, res) => {

  res.attachment("qrcodes.zip");

  const archive = archiver("zip");
  archive.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    for (let i = 0; i < rows.length; i++) {
      const url = `${req.protocol}://${req.get("host")}/?token=${rows[i].token}`;
      const qr = await QRCode.toBuffer(url);
      archive.append(qr, { name: `qr-${i + 1}.png` });
    }

    archive.finalize();
  });

});

// =========================
// PDF QR (GRIGLIA STABILE)
// =========================
app.get("/print-qrs", async (req, res) => {

  const doc = new PDFDocument({ margin: 30 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrcodes.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    const perRow = 3;
    const size = 120;
    const padding = 60;

    let col = 0;
    let row = 0;

    for (let i = 0; i < rows.length; i++) {

      const url = `${req.protocol}://${req.get("host")}/?token=${rows[i].token}`;
      const qr = await QRCode.toDataURL(url);
      const img = Buffer.from(qr.split(",")[1], "base64");

      const x = 50 + col * (size + padding);
      const y = 50 + row * (size + 70);

      doc.image(img, x, y, { width: size });
      doc.fontSize(10);
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
// START SERVER
// =========================
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

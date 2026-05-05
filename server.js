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
// MIDDLEWARE
// =========================
app.use(cors());
app.use(express.json());
app.use(express.static("public"));

// =========================
// DB
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

  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (!err && row && row.count === 0) {
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
// PAGES
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

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
// STATO VOTAZIONE
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
  db.run("DELETE FROM votes", (err) => {
    if (err) return res.json({ error: "Errore reset voti" });
    res.json({ ok: true });
  });
});

// =========================
// VOTO
// =========================
app.post("/vote", (req, res) => {

  const { token, percorso, scuola } = req.body;

  if (statoVotazione === "pre")
    return res.json({ error: "Votazione non aperta" });

  if (statoVotazione === "closed")
    return res.json({ error: "Votazione chiusa" });

  db.get("SELECT * FROM tokens WHERE token=?", [token], (err, row) => {

    if (err || !row)
      return res.json({ error: "Token non valido" });

    db.get(
      "SELECT COUNT(*) as count FROM votes WHERE token=?",
      [token],
      (err, result) => {

        if (result && result.count >= MAX_VOTES) {
          return res.json({ error: "Limite voti raggiunto" });
        }

        db.run(
          "INSERT INTO votes(token,percorso,scuola) VALUES(?,?,?)",
          [token, percorso, scuola],
          (err) => {
            if (err) return res.json({ error: "Errore server voto" });
            res.json({ success: true });
          }
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

    if (err) {
      return res.json({ totale: 0, risultati: [] });
    }

    db.get("SELECT COUNT(*) as totale FROM votes", (err2, tot) => {

      res.json({
        totale: tot?.totale || 0,
        risultati: rows || []
      });

    });

  });

});

// =========================
// TOKENS
// =========================
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    if (err) return res.json([]);
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

    if (err || !rows) {
      return archive.finalize();
    }

    for (let i = 0; i < rows.length; i++) {
      const url = `${req.protocol}://${req.get("host")}/?token=${rows[i].token}`;
      const qr = await QRCode.toBuffer(url);
      archive.append(qr, { name: `qr-${i + 1}.png` });
    }

    archive.finalize();
  });

});

// =========================
// PDF QR
// =========================
app.get("/print-qrs", async (req, res) => {

  const doc = new PDFDocument({ margin: 30 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrcodes.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    if (err || !rows) {
      doc.end();
      return;
    }

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
      doc.text(`QR ${i + 1}`, x, y + size + 5, {
        width: size,
        align: "center"
      });

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

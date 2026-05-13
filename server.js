const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// ================= CONFIG
const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";
const PARTICIPANTI = 350;
const MAX_VOTES = 2;

// ================= STATE
let votingState = "pre";

// ================= MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ================= DB
const db = new sqlite3.Database("votes.db");

// ================= INIT
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS votes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      id_progetto INTEGER,
      token TEXT,
      percorso TEXT,
      scuola TEXT,
      titolo TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY
    )
  `);

  const stmt = db.prepare("INSERT OR IGNORE INTO tokens(token) VALUES(?)");

  for (let i = 1; i <= PARTICIPANTI; i++) {
    stmt.run(`LAB2GO-${String(i).padStart(3, "0")}`);
  }

  stmt.finalize();
});

// ================= HELPERS
const disciplina = (p) => p.split(" - ")[0].trim();

// ================= ROUTES BASIC
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public/vote.html")));
app.get("/results-view", (_, res) => res.sendFile(path.join(__dirname, "public/results-view.html")));

app.get("/status", (_, res) => res.json({ stato: votingState }));

app.get("/open-vote", (_, res) => {
  votingState = "open";
  res.json({ ok: true });
});

app.get("/close-vote", (_, res) => {
  votingState = "closed";
  res.json({ ok: true });
});

app.get("/reset-votes", (_, res) => {
  votingState = "pre";
  db.run("DELETE FROM votes");
  res.json({ ok: true });
});

// ================= VOTE
app.post("/vote", (req, res) => {
  const { token, id_progetto, percorso, scuola, titolo } = req.body;

  if (!token) return res.json({ error: "QR non valido" });
  if (votingState !== "open") return res.json({ error: "Votazione chiusa" });

  db.get("SELECT token FROM tokens WHERE token=?", [token], (err, row) => {
    if (!row) return res.json({ error: "Token non valido" });

    db.get(
      "SELECT COUNT(*) AS c FROM votes WHERE token=?",
      [token],
      (err, c) => {
        if (c.c >= MAX_VOTES) return res.json({ error: "Limite voti" });

        db.run(
          "INSERT INTO votes(token,id_progetto,percorso,scuola,titolo) VALUES(?,?,?,?,?)",
          [token, id_progetto, percorso, scuola, titolo],
          () => res.json({ success: true })
        );
      }
    );
  });
});

// ================= RESULTS
app.get("/results-data", (_, res) => {
  db.all(
    `SELECT id_progetto, percorso, scuola, titolo, COUNT(*) as votes
     FROM votes
     GROUP BY id_progetto, percorso, scuola, titolo
     ORDER BY votes DESC`,
    (_, rows) => res.json({ risultati: rows || [] })
  );
});

// ================= QR PDF (FAST + STABLE)
app.get("/print-qrs", async (_, res) => {
  const doc = new PDFDocument({ size: "A4", margin: 20 });

  res.setHeader("Content-Type", "application/pdf");
  doc.pipe(res);

  db.all("SELECT token FROM tokens ORDER BY token ASC", async (_, rows) => {
    const cols = 4;
    const size = 120;

    for (let i = 0; i < rows.length; i++) {
      const t = rows[i].token;

      const qr = await QRCode.toDataURL(`${BASE_URL}/?token=${t}`);
      const img = Buffer.from(qr.split(",")[1], "base64");

      const x = 50 + (i % cols) * size;
      const y = 50 + Math.floor(i / cols) * size;

      doc.image(img, x, y, { width: 80 });
      doc.fontSize(8).text(t, x, y + 85, { width: 80, align: "center" });
    }

    doc.end();
  });
});

// ================= EXCEL EXPORT (QR STATUS)
app.get("/export-excel", async (_, res) => {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Tokens");

  sheet.columns = [
    { header: "Token", key: "token", width: 20 },
    { header: "Voti", key: "votes", width: 10 }
  ];

  db.all(
    `SELECT t.token, COUNT(v.id) as votes
     FROM tokens t
     LEFT JOIN votes v ON t.token=v.token
     GROUP BY t.token
     ORDER BY t.token ASC`,
    async (_, rows) => {
      rows.forEach(r => sheet.addRow(r));

      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
      );

      res.setHeader(
        "Content-Disposition",
        "attachment; filename=voti.xlsx"
      );

      await workbook.xlsx.write(res);
      res.end();
    }
  );
});

// ================= START
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

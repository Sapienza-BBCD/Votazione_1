const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const ExcelJS = require("exceljs");

const app = express();
const PORT = process.env.PORT || 3000;

// ========================= CONFIG
const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";
const PARTICIPANTI = 350;
const MAX_VOTES = 2;

// ========================= STATE
let votingState = "pre";

// ========================= MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ========================= DB
const db = new sqlite3.Database("votes.db");

// ========================= INIT DB
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

// ========================= HELPERS
function getDisciplina(percorso) {
  return (percorso || "").split(" - ")[0].trim();
}

// ========================= PAGES
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

app.get("/results-view", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "results-view.html"));
});

// ========================= STATUS SYSTEM
app.get("/status", (req, res) => {
  res.json({ stato: votingState });
});

app.get("/open-vote", (req, res) => {
  votingState = "open";
  res.json({ ok: true });
});

app.get("/close-vote", (req, res) => {
  votingState = "closed";
  res.json({ ok: true });
});

app.get("/reset-votes", (req, res) => {
  votingState = "pre";
  db.run("DELETE FROM votes", () => res.json({ ok: true }));
});

// ========================= TOKEN STATUS
app.get("/vote-status/:token", (req, res) => {

  db.get(
    "SELECT COUNT(*) AS used FROM votes WHERE token=?",
    [req.params.token],
    (err, row) => {

      if (err) return res.json({ error: "server error" });

      const used = row?.used || 0;

      res.json({
        used,
        remaining: Math.max(0, MAX_VOTES - used),
        max: MAX_VOTES
      });
    }
  );
});

// ========================= VOTE
app.post("/vote", (req, res) => {

  const { token, id_progetto, percorso, scuola, titolo } = req.body;

  if (!token) return res.json({ error: "QR non valido" });
  if (votingState !== "open") return res.json({ error: "Votazione non attiva" });

  db.get("SELECT token FROM tokens WHERE token=?", [token], (err, row) => {

    if (!row) return res.json({ error: "Token non valido" });

    db.get(
      "SELECT COUNT(*) AS count FROM votes WHERE token=?",
      [token],
      (err2, countRow) => {

        if ((countRow?.count || 0) >= MAX_VOTES) {
          return res.json({ error: "Hai esaurito i voti" });
        }

        db.all(
          "SELECT percorso FROM votes WHERE token=?",
          [token],
          (err3, rows) => {

            const nuova = getDisciplina(percorso);
            const gia = (rows || []).map(r => getDisciplina(r.percorso));

            if (gia.includes(nuova)) {
              return res.json({ error: "Hai già votato questa disciplina" });
            }

            db.run(
              "INSERT INTO votes(id_progetto,token,percorso,scuola,titolo) VALUES(?,?,?,?,?)",
              [id_progetto, token, percorso, scuola, titolo],
              (err4) => {

                if (err4) return res.json({ error: "Errore salvataggio" });

                res.json({ success: true });
              }
            );
          }
        );
      }
    );
  });
});

// ========================= RESULTS
app.get("/results-data", (req, res) => {

  db.all(`
    SELECT
      id_progetto,
      percorso,
      scuola,
      titolo,
      COUNT(*) as votes
    FROM votes
    GROUP BY id_progetto, percorso, scuola, titolo
    ORDER BY votes DESC
  `, (err, rows) => {

    if (err) return res.json({ error: err.message });

    res.json({ risultati: rows || [] });
  });
});

// ========================= CLASSIFICA DISCIPLINE
app.get("/api/classifica-discipline", (req, res) => {

  db.all(`
    SELECT
      id_progetto,
      percorso,
      scuola,
      titolo,
      COUNT(*) as votes
    FROM votes
    GROUP BY id_progetto, percorso, scuola, titolo
    ORDER BY votes DESC
  `, (err, rows) => {

    if (err) return res.json({ error: err.message });

    const grouped = {};

    rows.forEach(r => {

      const disciplina = getDisciplina(r.percorso);

      if (!grouped[disciplina]) grouped[disciplina] = [];

      grouped[disciplina].push({
        id: r.id_progetto,
        scuola: r.scuola,
        titolo: r.titolo,
        voti: r.votes,
        percorso: r.percorso
      });
    });

    res.json(
      Object.keys(grouped).map(disciplina => ({
        disciplina,
        progetti: grouped[disciplina]
      }))
    );
  });
});

// ========================= QR PDF
app.get("/print-qrs", (req, res) => {

  const doc = new PDFDocument({ size: "A4", margin: 0 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrs.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens ORDER BY token ASC", async (err, rows) => {

    if (err || !rows) return doc.end();

    const cols = 4;
    const rowsPerPage = 6;

    const cellW = 130;
    const cellH = 120;
    const qrSize = 80;

    for (let i = 0; i < rows.length; i++) {

      if (i > 0 && i % (cols * rowsPerPage) === 0) {
        doc.addPage();
      }

      const col = i % cols;
      const row = Math.floor(i / cols) % rowsPerPage;

      const x = 45 + col * cellW;
      const y = 50 + row * cellH;

      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toDataURL(url, { width: 300 });

      const img = Buffer.from(qr.split(",")[1], "base64");

      doc.image(img, x + 25, y + 10, { width: qrSize });

      doc.fontSize(8)
         .text(rows[i].token, x, y + 95, {
           width: cellW,
           align: "center"
         });

      // crocini
      doc.strokeColor("#ccc").lineWidth(0.3);

      doc.moveTo(x, y).lineTo(x + 10, y).stroke();
      doc.moveTo(x, y).lineTo(x, y + 10).stroke();

      doc.moveTo(x + cellW, y + cellH).lineTo(x + cellW - 10, y + cellH).stroke();
      doc.moveTo(x + cellW, y + cellH).lineTo(x + cellW, y + cellH - 10).stroke();
    }

    doc.end();
  });
});

// ========================= EXPORT EXCEL
app.get("/export-excel", async (req, res) => {

  const workbook = new ExcelJS.Workbook();

  const sheet = workbook.addWorksheet("Statistiche");

  const totalVotes = await new Promise(r =>
    db.get("SELECT COUNT(*) AS c FROM votes", (_, row) => r(row?.c || 0))
  );

  const usedQR = await new Promise(r =>
    db.get("SELECT COUNT(DISTINCT token) AS c FROM votes", (_, row) => r(row?.c || 0))
  );

  sheet.addRows([
    ["Totale voti", totalVotes],
    ["QR usati", usedQR],
    ["QR non usati", PARTICIPANTI - usedQR]
  ]);

  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  await workbook.xlsx.write(res);
  res.end();
});

// ========================= START
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

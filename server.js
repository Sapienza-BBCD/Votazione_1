const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

const app = express();
const PORT = process.env.PORT || 3000;

// ========================= CONFIG
const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";
const PARTICIPANTI = 350;
const MAX_VOTES = 2;

// ========================= STATO VOTAZIONE
let votingState = "pre"; // pre | open | closed

// ========================= MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ========================= DB
const db = new sqlite3.Database("votes.db");

// ========================= INIT DB
db.serialize(() => {

  // VOTI
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

  // TOKEN (QR FISSI)
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY
    )
  `);

  // genera token solo una volta
  const stmt = db.prepare("INSERT OR IGNORE INTO tokens(token) VALUES(?)");

  for (let i = 1; i <= PARTICIPANTI; i++) {
    stmt.run(`LAB2GO-${String(i).padStart(3, "0")}`);
  }

  stmt.finalize();
});

// ========================= HELPERS
function getDisciplina(percorso) {
  return percorso.split(" - ")[0].trim();
}

// ========================= PAGES
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

app.get("/results-view", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "results-view.html"));
});

// ========================= STATUS
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

  db.run("DELETE FROM votes", (err) => {
    if (err) return res.json({ ok: false, error: err.message });
    res.json({ ok: true });
  });
});

// ========================= STATUS TOKEN
app.get("/vote-status/:token", (req, res) => {

  const token = req.params.token;

  db.get(
    "SELECT COUNT(*) AS used FROM votes WHERE token=?",
    [token],
    (err, row) => {

      if (err) return res.json({ error: "server error" });

      res.json({
        used: row?.used || 0,
        remaining: Math.max(0, MAX_VOTES - (row?.used || 0)),
        max: MAX_VOTES
      });
    }
  );
});

// ========================= VOTO
app.post("/vote", (req, res) => {

  const { token, id_progetto, percorso, scuola, titolo } = req.body;

  if (!token) return res.json({ error: "QR non valido" });

  if (votingState !== "open") {
    return res.json({ error: "Votazione non attiva" });
  }

  db.get(
    "SELECT token FROM tokens WHERE token=?",
    [token],
    (err, row) => {

      if (!row) return res.json({ error: "Token non valido" });

      // duplicato stesso progetto
      db.get(
        "SELECT 1 FROM votes WHERE token=? AND percorso=? AND scuola=? AND titolo=?",
        [token, percorso, scuola, titolo],
        (err2, dup) => {

          if (dup) {
            return res.json({ error: "Già votato questo progetto" });
          }

          // limite voti
          db.get(
            "SELECT COUNT(*) AS count FROM votes WHERE token=?",
            [token],
            (err3, countRow) => {

              if ((countRow?.count || 0) >= MAX_VOTES) {
                return res.json({ error: "Hai esaurito i voti" });
              }

              // stessa disciplina
              db.all(
                "SELECT percorso FROM votes WHERE token=?",
                [token],
                (err4, rows) => {

                  const nuova = getDisciplina(percorso);
                  const gia = (rows || []).map(r => getDisciplina(r.percorso));

                  if (gia.includes(nuova)) {
                    return res.json({ error: "Hai già votato questa disciplina" });
                  }

                  // INSERT VOTO
                  db.run(
                    "INSERT INTO votes(id_progetto,token,percorso,scuola,titolo) VALUES(?,?,?,?,?)",
                    [id_progetto, token, percorso, scuola, titolo],
                    (err5) => {

                      if (err5) {
                        return res.json({ error: "Errore salvataggio" });
                      }

                      res.json({ success: true });
                    }
                  );
                }
              );
            }
          );
        }
      );
    }
  );
});

// ========================= RESULTS + CLASSIFICA
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

    if (err) {
      return res.json({ error: err.message });
    }

    res.json({
      risultati: rows || []
    });

  });

});

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

    if (err) {
      return res.json({ error: err.message });
    }

    // raggruppa per disciplina
    const grouped = {};

    rows.forEach(r => {

      const parts = r.percorso.split(" - ");

      const disciplina = parts[0] || "Altro";
      const tipo = parts[1] || "Altro";

      if (!grouped[disciplina]) {
        grouped[disciplina] = [];
      }

      grouped[disciplina].push({
        id: r.id_progetto,
        tipo,
        voti: r.votes,
        scuola: r.scuola,
        titolo: r.titolo,
        percorso: r.percorso
      });

    });

    // array finale
    const result = Object.keys(grouped).map(disciplina => ({
      disciplina,
      progetti: grouped[disciplina]
    }));

    res.json(result);

  });

});

// ========================= DEBUG
app.get("/debug-votes", (req, res) => {
  db.all("SELECT * FROM votes", (err, rows) => {
    if (err) return res.json({ error: err.message });
    res.json(rows || []);
  });
});

app.get("/debug-tokens", (req, res) => {
  db.all("SELECT * FROM tokens", (err, rows) => {
    if (err) return res.json({ error: err.message });
    res.json(rows || []);
  });
});

// ========================= QR PDF
app.get("/print-qrs", (req, res) => {
  const doc = new PDFDocument({ size: "A4", margin: 0 }); // Margini gestiti manualmente

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrs_professionali.pdf");
  doc.pipe(res);

  db.all("SELECT token FROM tokens ORDER BY token ASC", async (err, rows) => {
    if (err || !rows) return doc.end();

    // --- CONFIGURAZIONE GRIGLIA ---
    const cols = 4;
    const rowsPerPage = 6;
    const cellWidth = 130;  // circa 4.6 cm
    const cellHeight = 120; // circa 4.2 cm
    const qrSize = 80;
    const startX = 45;      // Centratura orizzontale
    const startY = 50;      // Centratura verticale

    for (let i = 0; i < rows.length; i++) {
      const col = i % cols;
      const row = Math.floor(i / cols) % rowsPerPage;

      if (i > 0 && i % (cols * rowsPerPage) === 0) doc.addPage();

      const x = startX + col * cellWidth;
      const y = startY + row * cellHeight;

      // Generazione QR
      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toDataURL(url, {
        margin: 1,
        width: 300
      });
      const img = Buffer.from(qr.split(",")[1], "base64");

      // 1. Stampa QR Code (centrato nella cella)
      doc.image(img, x + (cellWidth - qrSize) / 2, y + 10, { width: qrSize });

      // 2. Testo Token
      doc.fontSize(8).fillColor("black")
         .text(rows[i].token, x, y + qrSize + 15, { width: cellWidth, align: "center" });

      // 3. LINEE DI TAGLIO (Crocini)
      doc.lineWidth(0.2).strokeColor("#CCCCCC"); // Colore grigio chiaro per non disturbare
      
      // Angolo alto-sx
      doc.moveTo(x, y).lineTo(x + 10, y).stroke();
      doc.moveTo(x, y).lineTo(x, y + 10).stroke();
      
      // Angolo basso-dx
      doc.moveTo(x + cellWidth, y + cellHeight).lineTo(x + cellWidth - 10, y + cellHeight).stroke();
      doc.moveTo(x + cellWidth, y + cellHeight).lineTo(x + cellWidth, y + cellHeight - 10).stroke();

      // 4. CORNICE LEGGERA (Opzionale, serve come guida visiva)
      doc.rect(x, y, cellWidth, cellHeight)
         .dash(2, { space: 2 })
         .stroke();
      doc.undash();
    }

    doc.end();
  });
});
// ========================= RESET TOKENS
app.get("/reset-tokens", (req, res) => {

  db.run("DELETE FROM tokens", err => {

    if (err) {
      return res.json({ error: err.message });
    }

    const stmt = db.prepare(
      "INSERT INTO tokens(token) VALUES(?)"
    );

    for (let i = 1; i <= PARTICIPANTI; i++) {

      stmt.run(
        `LAB2GO-${String(i).padStart(3, "0")}`
      );
    }

    stmt.finalize();

    res.json({ ok: true });
  });
});

// ================= EXCEL EXPORT (QR STATUS)
app.get("/export-excel", async (_, res) => {
  const workbook = new ExcelJS.Workbook();

  // =========================
  // SHEET 1: VOTI PER PROGETTO
  // =========================
  const projectsSheet = workbook.addWorksheet("Risultati");

  projectsSheet.columns = [
    { header: "ID Progetto", key: "id_progetto", width: 15 },
    { header: "Titolo", key: "titolo", width: 30 },
    { header: "Scuola", key: "scuola", width: 25 },
    { header: "Percorso", key: "percorso", width: 30 },
    { header: "Voti", key: "votes", width: 10 }
  ];

  const results = await new Promise((resolve) => {
    db.all(`
      SELECT
        id_progetto,
        titolo,
        scuola,
        percorso,
        COUNT(*) as votes
      FROM votes
      GROUP BY id_progetto, titolo, scuola, percorso
      ORDER BY votes DESC
    `, (_, rows) => resolve(rows || []));
  });

  results.forEach(r => projectsSheet.addRow(r));

  // =========================
  // SHEET 2: TOKEN STATUS
  // =========================
  const tokenSheet = workbook.addWorksheet("Token");

  tokenSheet.columns = [
    { header: "Token", key: "token", width: 20 },
    { header: "Voti effettuati", key: "votes", width: 18 },
    { header: "Usato", key: "used", width: 10 }
  ];

  const tokens = await new Promise((resolve) => {
    db.all(`
      SELECT
        t.token,
        COUNT(v.id) as votes
      FROM tokens t
      LEFT JOIN votes v ON t.token = v.token
      GROUP BY t.token
      ORDER BY t.token ASC
    `, (_, rows) => resolve(rows || []));
  });

  tokens.forEach(t => {
    tokenSheet.addRow({
      token: t.token,
      votes: t.votes,
      used: t.votes > 0 ? "SI" : "NO"
    });
  });

  // =========================
  // SHEET 3: DISCIPLINE (MATrice analisi)
  // =========================
  const disciplineSheet = workbook.addWorksheet("Discipline");

  disciplineSheet.columns = [
    { header: "Disciplina", key: "disciplina", width: 25 },
    { header: "Voti totali", key: "votes", width: 15 }
  ];

  const discipline = await new Promise((resolve) => {
    db.all(`
      SELECT percorso, COUNT(*) as votes
      FROM votes
      GROUP BY percorso
      ORDER BY votes DESC
    `, (_, rows) => resolve(rows || []));
  });

  const grouped = {};

  discipline.forEach(r => {
    const d = r.percorso.split(" - ")[0];
    grouped[d] = (grouped[d] || 0) + r.votes;
  });

  Object.entries(grouped).forEach(([disciplina, votes]) => {
    disciplineSheet.addRow({ disciplina, votes });
  });

  // =========================
  // STILE BASE
  // =========================
  workbook.eachSheet(sheet => {
    sheet.getRow(1).font = { bold: true };
    sheet.getRow(1).fill = {
      type: "pattern",
      pattern: "solid",
      fgColor: { argb: "FFE8F0FE" }
    };
  });

  // =========================
  // DOWNLOAD
  // =========================
  res.setHeader(
    "Content-Type",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
  );

  res.setHeader(
    "Content-Disposition",
    "attachment; filename=dashboard_votazione.xlsx"
  );

  await workbook.xlsx.write(res);
  res.end();
});

// ========================= START
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

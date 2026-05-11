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
    stmt.run(`LAB2GO-${i}`);
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

  const doc = new PDFDocument({ size: "A4", margin: 40 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrs.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    if (err || !rows) return doc.end();

    let x = 50;
    let y = 50;
    let i = 0;

    for (const r of rows) {

      const url = `${BASE_URL}/?token=${r.token}`;
      const qr = await QRCode.toDataURL(url);
      const img = Buffer.from(qr.split(",")[1], "base64");

      doc.image(img, x, y, { width: 80 });
      doc.text(r.token, x, y + 85);

      x += 100;
      i++;

      if (i % 5 === 0) {
        x = 50;
        y += 120;
      }

      if (i % 20 === 0) {
        doc.addPage();
        x = 50;
        y = 50;
      }
    }

    doc.end();
  });
});

// ========================= START
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

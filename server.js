const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 3000;

// ========================= CONFIG
const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";
const PARTICIPANTI = 350;
const MAX_VOTES = 2;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "lab2go";

// ========================= MIDDLEWARE
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ========================= DB
const db = new sqlite3.Database("votes.db");

// ========================= INIT DATABASE (STABILE)
db.serialize(() => {

  // VOTI
  db.run(`
    CREATE TABLE IF NOT EXISTS votes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT,
      percorso TEXT,
      scuola TEXT,
      titolo TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  // TOKEN (QR PERMANENTI)
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY
    )
  `);

  // STATO VOTAZIONE
  db.run(`
    CREATE TABLE IF NOT EXISTS settings(
      key TEXT PRIMARY KEY,
      value TEXT
    )
  `);

  // stato default
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    if (!row) {
      db.run("INSERT INTO settings(key,value) VALUES('stato','pre')");
    }
  });

  // =========================
  // 🔥 TOKEN: CREAZIONE DEFINITIVA
  // NON SI RIGENERANO MAI
  // =========================
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO tokens(token) VALUES(?)
  `);

  for (let i = 1; i <= PARTICIPANTI; i++) {
    stmt.run(`LAB2GO-${i}`);
  }

  stmt.finalize();
});

// ========================= HELPERS
function getStato(cb) {
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    cb(row?.value || "pre");
  });
}

function setStato(val, cb) {
  db.run("UPDATE settings SET value=? WHERE key='stato'", [val], cb);
}

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

// ========================= STATO VOTAZIONE
app.get("/open-vote", (req, res) => {
  setStato("open", () => res.json({ ok: true }));
});

app.get("/close-vote", (req, res) => {
  setStato("closed", () => res.json({ ok: true }));
});

app.get("/reset-vote-state", (req, res) => {

  setStato("pre", () => {
    res.json({ ok: true });
  });

});

app.get("/reset-votes", (req, res) => {

  setStato("pre", () => {

    db.run("DELETE FROM votes");

    res.json({ ok: true });

  });

});
  

// ========================= STATUS UTENTE
app.get("/vote-status/:token", (req, res) => {

  const token = req.params.token;

  db.get(
    "SELECT COUNT(*) AS used FROM votes WHERE token=?",
    [token],
    (err, row) => {

      if (err) return res.json({ error: "Errore server" });

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

  const { token, percorso, scuola, titolo } = req.body;

  if (!token) return res.json({ error: "QR non valido" });

  getStato((stato) => {

    if (stato !== "open") {
      return res.json({ error: "Votazione non attiva" });
    }

    db.get(
      "SELECT token FROM tokens WHERE token=?",
      [token],
      (err, row) => {

        if (!row) return res.json({ error: "Token non valido" });

        // stesso progetto
        db.get(
          "SELECT 1 FROM votes WHERE token=? AND percorso=? AND scuola=?",
          [token, percorso, scuola],
          (err2, dup) => {

            if (dup) {
              return res.json({ error: "Già votato questo progetto" });
            }

            // max voti
            db.get(
              "SELECT COUNT(*) AS count FROM votes WHERE token=?",
              [token],
              (err3, countRow) => {

                if ((countRow?.count ?? 0) >= MAX_VOTES) {
                  return res.json({ error: "Hai esaurito i voti" });
                }

                // disciplina diversa
                db.all(
                  "SELECT percorso FROM votes WHERE token=?",
                  [token],
                  (err4, rows) => {

                    const nuova = getDisciplina(percorso);
                    const gia = (rows || []).map(r =>getDisciplina(r.percorso)
                    );

                    if (gia.includes(nuova)) {
                      return res.json({ error: "Hai già votato questa disciplina" });
                    }

                    db.run(
                      "INSERT INTO votes(token,percorso,scuola,titolo) VALUES(?,?,?,?)",
                      [token, percorso, scuola, titolo],
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
});

// ========================= RISULTATI
app.get("/results-data", (req, res) => {

  db.all(`
    SELECT percorso, scuola, titolo, COUNT(*) as votes
    FROM votes
    GROUP BY percorso, scuola, titolo
    ORDER BY votes DESC
  `, (err, rows) => {

    if (err) return res.json({ error: "Errore risultati" });

    db.get("SELECT COUNT(*) as totale FROM votes", (err2, tot) => {

      res.json({
        totale: tot?.totale || 0,
        risultati: rows || []
      });

    });

  });

});

// ========================= QR PRINT (STABILE)
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
// =========================
// STATUS VOTAZIONE
// =========================
app.get("/status", (req, res) => {

  getStato((stato) => {

    res.json({
      stato
    });

  });

});
// =========================
// START
// ========================= 
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

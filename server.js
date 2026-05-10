const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const path = require("path");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");
const archiver = require("archiver");

const app = express();
const PORT = process.env.PORT || 3000;

// =========================
// CONFIG
// =========================
const BASE_URL = process.env.BASE_URL || "https://votazione-1.onrender.com";
const PARTICIPANTI = 350;
const MAX_VOTES = 2;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "lab2go";

// =========================
// MIDDLEWARE
// =========================
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// =========================
// DB
// =========================
const db = new sqlite3.Database("votes.db");

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
      titolo TEXT,
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

  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    if (!row) {
      db.run("INSERT INTO settings(key,value) VALUES('stato','pre')");
    }
  });

  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO tokens(token) VALUES(?)");
      for (let i = 1; i <= PARTICIPANTI; i++) {
        stmt.run(`LAB2GO-${i}`);
      }
      stmt.finalize();
    }
  });

});

// =========================
// HELPERS
// =========================
function getStato(cb) {
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    cb(row ? row.value : "pre");
  });
}

function setStato(val, cb) {
  db.run("UPDATE settings SET value=? WHERE key='stato'", [val], cb);
}

function getDisciplina(percorso) {
  return percorso.split(" - ")[0].trim();
}

// =========================
// PAGES
// =========================
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// =========================
// ADMIN STATO
// =========================
app.get("/open-vote", (req, res) => {
  setStato("open", () => res.json({ ok: true }));
});

app.get("/close-vote", (req, res) => {
  setStato("closed", () => res.json({ ok: true }));
});

app.get("/reset-vote", (req, res) => {
  setStato("pre", () => res.json({ ok: true }));
});

// =========================
// STATUS UTENTE
// =========================
app.get("/vote-status/:token", (req, res) => {

  const token = req.params.token;

  db.get("SELECT COUNT(*) AS used FROM votes WHERE token=?", [token], (err, row) => {

    if (err) return res.json({ error: "Errore server" });

    res.json({
      used: row.used,
      remaining: Math.max(0, MAX_VOTES - row.used),
      max: MAX_VOTES
    });

  });
});

// =========================
// VOTO
// =========================
app.post("/vote", (req, res) => {

  const { token, percorso, scuola, titolo } = req.body;

  if (!token) return res.json({ error: "QR non valido" });

    function getStato(cb) {
      db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
        if (err) {
          console.error(err);
          return cb("pre");
        }
        cb(row?.value || "pre");
      });
    }

    // token valido?
    db.get("SELECT token FROM tokens WHERE token=?", [token], (err, row) => {

      if (!row) return res.json({ error: "Token non valido" });

      // doppio voto stesso progetto
      db.get(
        "SELECT 1 FROM votes WHERE token=? AND percorso=? AND scuola=?",
        [token, percorso, scuola],
        (err2, dup) => {

          if (dup) {
            return res.json({ error: "Hai già votato questo progetto" });
          }

          // max 2 voti
          db.get(
            "SELECT COUNT(*) AS count FROM votes WHERE token=?",
            [token],
            (err3, countRow) => {

              if (countRow.count >= MAX_VOTES) {
                return res.json({ error: "Hai esaurito i voti" });
              }

              // disciplina diversa
              db.all(
                "SELECT percorso FROM votes WHERE token=?",
                [token],
                (err4, rows) => {

                  const nuova = getDisciplina(percorso);
                  const gia = rows.map(r => getDisciplina(r.percorso));

                  if (gia.includes(nuova)) {
                    return res.json({ error: "Hai già votato questa disciplina" });
                  }

                  db.run(
                    "INSERT INTO votes(token,percorso,scuola,titolo) VALUES(?,?,?,?)",
                    [token, percorso, scuola, titolo],
                    (err5) => {

                      if (err5) {
                        return res.json({ error: "Errore salvataggio voto" });
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
    });
  });
});

// =========================
// RISULTATI
// =========================
app.get("/results-data", (req, res) => {

  db.all(`
    SELECT percorso, scuola, titolo, COUNT(*) as votes
    FROM votes
    GROUP BY percorso, scuola, titolo
    ORDER BY votes DESC
  `, (err, rows) => {

    if (err) {
      console.error(err);
      return res.json({ error: "Errore risultati" });
    }

    db.get("SELECT COUNT(*) as totale FROM votes", (err2, tot) => {

      if (err2) {
        console.error(err2);
        return res.json({ error: "Errore conteggio" });
      }

      res.json({
        totale: tot?.totale || 0,
        risultati: rows || []
      });

    });

  });

});

// =========================
// START
// =========================
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

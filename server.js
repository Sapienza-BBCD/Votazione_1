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

  // stato iniziale
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    if (err) return console.error(err);

    if (!row) {
      db.run("INSERT INTO settings(key,value) VALUES('stato','pre')");
    }
  });

  // genera token
  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (err) return console.error(err);

    if (row && row.count === 0) {
      const stmt = db.prepare("INSERT INTO tokens(token) VALUES(?)");

      for (let i = 1; i <= PARTICIPANTI; i++) {
        stmt.run(`LAB2GO-${i}`);
      }

      stmt.finalize();
      console.log("Token generati:", PARTICIPANTI);
    }
  });

}); // ✅ CHIUSURA CORRETTA db.serialize()

// =========================
// HELPERS STATO
// =========================
function getStato(cb) {
  db.get("SELECT value FROM settings WHERE key='stato'", (err, row) => {
    if (err) {
      console.error(err);
      return cb("pre");
    }
    cb(row ? row.value : "pre");
  });
}

function setStato(val, cb) {
  db.run(
    "UPDATE settings SET value=? WHERE key='stato'",
    [val],
    (err) => {
      if (err) console.error(err);
      if (cb) cb();
    }
  );
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

app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

app.get("/results-view", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "results-view.html"));
});

// =========================
// ADMIN LOGIN
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
  setStato("open", () => res.json({ ok: true }));
});

app.get("/close-vote", (req, res) => {
  setStato("closed", () => res.json({ ok: true }));
});

app.get("/reset-vote", (req, res) => {
  setStato("pre", () => res.json({ ok: true }));
});

// =========================
// RESET VOTI
// =========================
app.get("/reset-votes", (req, res) => {
  db.run("DELETE FROM votes", function (err) {
    if (err) {
      console.error(err);
      return res.json({ error: "Errore reset voti" });
    }

    res.json({ ok: true, deleted: this.changes });
  });
});

// =========================
// VOTO (FIX LOGICO)
// =========================
app.post("/vote", (req, res) => {
  const { token, percorso, scuola, titolo } = req.body;

  getStato((stato) => {

    if (stato === "pre") return res.json({ error: "Votazione non aperta" });
    if (stato === "closed") return res.json({ error: "Votazione chiusa" });
    if (!token) return res.json({ error: "QR non valido" });

    db.get("SELECT token FROM tokens WHERE token=?", [token], (err, row) => {
      if (err) return res.json({ error: "Errore server" });
      if (!row) return res.json({ error: "Token non valido" });

      // 🔴 controllo doppio progetto
      db.get(
        "SELECT 1 FROM votes WHERE token=? AND percorso=? AND scuola=?",
        [token, percorso, scuola],
        (errDup, dup) => {

          if (errDup) return res.json({ error: "Errore server" });

          if (dup) {
            return res.json({
              error: "Hai già votato questo progetto"
            });
          }

          db.get(
            "SELECT COUNT(*) as count FROM votes WHERE token=?",
            [token],
            (err2, result) => {

              if (err2) return res.json({ error: "Errore server" });

              if (result.count >= MAX_VOTES) {
                return res.json({
                  error: "Hai già usato i 2 voti disponibili"
                });
              }

              db.all(
                "SELECT percorso FROM votes WHERE token=?",
                [token],
                (err4, rows) => {

                  if (err4) return res.json({ error: "Errore server" });

                  const nuovaDisciplina = getDisciplina(percorso);

                  const giaVotate = new Set(
                    rows.map(r => getDisciplina(r.percorso))
                  );

                  if (giaVotate.has(nuovaDisciplina)) {
                    return res.json({
                      error: "Hai già votato questa disciplina"
                    });
                  }

                  db.run(
                    "INSERT INTO votes(token,percorso,scuola,titolo) VALUES(?,?,?,?)",
                    [token, percorso, scuola, titolo],
                    (err3) => {

                      if (err3) {
                        return res.json({
                          error: "Errore inserimento voto"
                        });
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
    SELECT percorso, scuola, COUNT(*) as votes
    FROM votes
    GROUP BY percorso, scuola
    ORDER BY percorso, votes DESC
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
// STATUS TOKEN / VOTI RIMANENTI
// =========================
app.get("/vote-status/:token", (req, res) => {

  const token = req.params.token;

  db.get(
    "SELECT COUNT(*) as count FROM votes WHERE token=?",
    [token],
    (err, row) => {

      if (err) {
        console.error(err);
        return res.json({ error: "Errore server" });
      }

      const used = row?.count || 0;

      res.json({
        used,
        remaining: Math.max(0, MAX_VOTES - used),
        max: MAX_VOTES
      });
    }
  );
});

// =========================
// TOKENS
// =========================
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    if (err) {
      console.error(err);
      return res.json([]);
    }
    res.json(rows);
  });
});

// =========================
// DOWNLOAD QR ZIP
// =========================
app.get("/download-qrs", (req, res) => {

  res.attachment("qrcodes.zip");

  const archive = archiver("zip");
  archive.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {
    if (err || !rows) {
      console.error(err);
      return archive.finalize();
    }

    for (let i = 0; i < rows.length; i++) {
      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toBuffer(url);
      archive.append(qr, { name: `qr-${i + 1}.png` });
    }

    archive.finalize();
  });
});

// =========================
// PDF QR
// =========================
app.get("/print-qrs", (req, res) => {

  const doc = new PDFDocument({ size: "A4", margin: 40 });

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrcodes.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    if (err || !rows) {
      console.error(err);
      doc.end();
      return;
    }

    const cols = 3;
    const rowsPerPage = 4;

    const qrSize = 85;
    const labelHeight = 15;
    const cellHeight = qrSize + labelHeight + 10;

    const marginX = 40;
    const marginY = 40;

    const usableWidth = doc.page.width - marginX * 2;
    const usableHeight = doc.page.height - marginY * 2;

    const spacingX = (usableWidth - cols * qrSize) / (cols - 1);
    const spacingY = (usableHeight - rowsPerPage * cellHeight) / (rowsPerPage - 1);

    let col = 0;
    let row = 0;

    for (let i = 0; i < rows.length; i++) {

      const url = `${BASE_URL}/?token=${rows[i].token}`;
      const qr = await QRCode.toDataURL(url);

      const img = Buffer.from(qr.split(",")[1], "base64");

      const x = marginX + col * (qrSize + spacingX);
      const y = marginY + row * (cellHeight + spacingY);

      doc.image(img, x, y, { width: qrSize });

      doc.fontSize(9).text(`QR ${i + 1}`, x, y + qrSize + 5, {
        width: qrSize,
        align: "center"
      });

      col++;
      if (col === cols) {
        col = 0;
        row++;
      }

      if (row === rowsPerPage && i < rows.length - 1) {
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

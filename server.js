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

// Middleware
app.use(express.static("public"));
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("votes.db");
const PARTICIPANTI = 300; // numero di token da generare

// --- Creazione tabelle e token ---
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS votes(
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      token TEXT,
      choice TEXT,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY,
      used INTEGER DEFAULT 0
    )
  `);

  // Genera token solo se tabella vuota
  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {
    if (err) return console.error(err);
    if (row.count === 0) {
      for (let i = 0; i < PARTICIPANTI; i++) {
        const token = uuidv4();
        db.run("INSERT INTO tokens(token) VALUES(?)", [token]);
      }
      console.log(`${PARTICIPANTI} token generati sul server!`);
    }
  });
});

// --- ROTTE ---

// "/" → vote.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// POST /vote → registra voto multiplo
app.post("/vote", (req, res) => {
  const { token, choice } = req.body;

  db.get("SELECT * FROM tokens WHERE token=?", [token], (err, row) => {
    if (err) return res.json({ error: "Errore server" });
    if (!row) return res.json({ error: "Token non valido" });
    if (row.used === 1) return res.json({ error: "Token già usato" });

    const choices = Array.isArray(choice) ? choice : choice.split(",").map(c => c.trim());

    // Inserisci ogni progetto selezionato come riga separata
    let completed = 0;
    for (let c of choices) {
      db.run("INSERT INTO votes(token, choice) VALUES(?, ?)", [token, c], (err) => {
        if (err) console.log(err);
        completed++;
        if (completed === choices.length) {
          // Una volta inseriti tutti i voti, segna token come usato
          db.run("UPDATE tokens SET used=1 WHERE token=?", [token], (err) => {
            if (err) console.log(err);
            res.json({ success: true });
          });
        }
      });
    }
  });
});

// GET /results → risultati
app.get("/results", (req, res) => {
  db.all("SELECT choice, COUNT(*) AS votes FROM votes GROUP BY choice", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// GET /tokens → lista token (debug/admin)
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// GET /admin → admin.html
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// GET /download-qrs → zip dei QR
app.get("/download-qrs", async (req, res) => {
  res.attachment("qrcodes.zip");
  const archive = archiver("zip");
  archive.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {
    if (err) {
      res.status(500).send("Errore server");
      return;
    }

    for (let i = 0; i < rows.length; i++) {
      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/vote.html?token=${token}`;
      const qr = await QRCode.toBuffer(url);
      archive.append(qr, { name: `qr-${i + 1}.png` });
    }

    archive.finalize();
  });
});

// GET /print-qrs → PDF dei QR
app.get("/print-qrs", async (req, res) => {
  const doc = new PDFDocument({ margin: 30 });
  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", "inline; filename=qrcodes.pdf");
  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {
    if (err) {
      doc.text("Errore server");
      doc.end();
      return;
    }

    const perRow = 3;
    const size = 150;
    let x = 50, y = 50, count = 0;

    for (let i = 0; i < rows.length; i++) {
      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/vote.html?token=${token}`;
      const qr = await QRCode.toDataURL(url);
      const base64 = qr.replace(/^data:image\/png;base64,/, "");
      const img = Buffer.from(base64, "base64");

      doc.image(img, x, y, { width: size });
      doc.fontSize(10).text(`QR ${i + 1}`, x, y + size + 5);

      count++;
      x += 180;

      if (count % perRow === 0) {
        x = 50;
        y += 200;
      }

      if (y > 700) {
        doc.addPage();
        x = 50;
        y = 50;
      }
    }

    doc.end();
  });
});

// Avvio server
app.listen(PORT, () => {
  console.log(`Server attivo su porta ${PORT}`);
});
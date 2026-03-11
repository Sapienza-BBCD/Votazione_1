const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const archiver = require("archiver");
const QRCode = require("qrcode");
const PDFDocument = require("pdfkit");

const PORT = process.env.PORT || 3000;

const app = express();

// Cartella statica
app.use(express.static("public"));
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("votes.db");

// Numero di token da generare
const PARTICIPANTI = 300;

db.serialize(() => {

  // Crea tabelle se non esistono
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

  // Genera token solo se la tabella è vuota
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

// "/" → mostra vote.html (così i QR continuano a funzionare)
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// Votazione con token
app.post("/vote", (req, res) => {
  const { token, choice } = req.body;

  db.get("SELECT * FROM tokens WHERE token=?", [token], (err, row) => {
    if (err) return res.json({ error: "Errore server" });
    if (!row) return res.json({ error: "Token non valido" });
    if (row.used === 1) return res.json({ error: "Token già usato" });

    db.run("INSERT INTO votes(token, choice) VALUES(?,?)", [token, choice]);
    db.run("UPDATE tokens SET used=1 WHERE token=?", [token]);

    res.json({ success: true });
  });
});

// Controllo risultati
app.get("/results", (req, res) => {
  db.all("SELECT choice, COUNT(*) as votes FROM votes GROUP BY choice", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// Lista dei token (opzionale per debug/admin)
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// Admin.html (i risultati grafici)
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// Scarica tutti i QR in ZIP
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

      archive.append(qr, { name: `qr-${i+1}.png` });

    }

    archive.finalize();

  });

});

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

    let x = 50;
    let y = 50;
    let count = 0;

    for (let i = 0; i < rows.length; i++) {

      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/vote.html?token=${token}`;

      const qr = await QRCode.toDataURL(url);

      const base64 = qr.replace(/^data:image\/png;base64,/, "");
      const img = Buffer.from(base64, "base64");

      doc.image(img, x, y, { width: size });

      doc.fontSize(10).text(`QR ${i+1}`, x, y + size + 5);

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
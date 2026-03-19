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

// Database
const db = new sqlite3.Database("votes.db");

const PARTICIPANTI = 300;
const MAX_VOTES = 2;
const ADMIN_PASSWORD = "lab2go";

// Stato votazione
let statoVotazione = "pre";

// --- CREAZIONE DB ---
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
    if (row.count === 0) {
      for (let i = 0; i < PARTICIPANTI; i++) {
        const token = uuidv4();
        db.run("INSERT INTO tokens(token) VALUES(?)", [token]);
      }
      console.log("Token generati:", PARTICIPANTI);
    }
  });

});

// --- ROUTES ---

// HOME
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "vote.html"));
});

// VOTO
app.post("/vote", (req, res) => {

  if (statoVotazione === "pre") {
    return res.json({ error: "La votazione non è ancora aperta" });
  }

  if (statoVotazione === "closed") {
    return res.json({ error: "La votazione è chiusa" });
  }

  const { token, percorso, scuola } = req.body;

  db.get("SELECT * FROM tokens WHERE token=?", [token], (err, row) => {

    if (err) return res.json({ error: "Errore server" });
    if (!row) return res.json({ error: "Token non valido" });

    db.get(
      "SELECT COUNT(*) as count FROM votes WHERE token=?",
      [token],
      (err, result) => {

        if (result.count >= MAX_VOTES) {
          return res.json({ error: "Hai già usato i tuoi 2 voti" });
        }

        db.run(
          "INSERT INTO votes(token, percorso, scuola) VALUES(?,?,?)",
          [token, percorso, scuola],
          (err) => {
            if (err) return res.json({ error: "Errore server" });
            res.json({ success: true });
          }
        );

      }
    );

  });

});

// --- CONTROLLO VOTAZIONE ---
app.get("/open-vote", (req, res) => {
  statoVotazione = "open";
  res.send("Votazione APERTA");
});

app.get("/close-vote", (req, res) => {
  statoVotazione = "closed";
  res.send("Votazione CHIUSA");
});

app.get("/reset-vote", (req, res) => {
  statoVotazione = "pre";
  res.send("Votazione NON ANCORA APERTA");
});

// --- RESET VOTI (IMPORTANTISSIMO) ---
app.get("/reset-votes", (req, res) => {
  db.run("DELETE FROM votes");
  res.send("Voti resettati");
});

// --- RISULTATI JSON (CORRETTO) ---
app.get("/results-data", (req, res) => {

  db.all(`
    SELECT percorso, scuola, COUNT(*) as votes
    FROM votes
    GROUP BY percorso, scuola
    ORDER BY percorso, votes DESC
  `, (err, rows) => {

    if (err) return res.json({ error: "Errore server" });

    db.get("SELECT COUNT(*) as totale FROM votes", (err2, tot) => {

      res.json({
        totale: tot.totale,
        risultati: rows
      });

    });

  });

});

// --- PAGINA RISULTATI ---
app.get("/results-view", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "results-view.html"));
});

// --- ADMIN LOGIN PAGE ---
app.get("/admin", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin-login.html"));
});

// --- LOGIN ADMIN ---
app.post("/admin-login", (req, res) => {
  const { password } = req.body;

  if (password !== ADMIN_PASSWORD) {
    return res.json({ error: "Password errata" });
  }

  res.json({ success: true });
});

// --- TOKEN LIST ---
app.get("/tokens", (req, res) => {
  db.all("SELECT token FROM tokens", (err, rows) => {
    if (err) return res.json({ error: "Errore server" });
    res.json(rows);
  });
});

// --- DOWNLOAD QR ZIP ---
app.get("/download-qrs", async (req, res) => {

  res.attachment("qrcodes.zip");

  const archive = archiver("zip");
  archive.pipe(res);

  db.all("SELECT token FROM tokens", async (err, rows) => {

    for (let i = 0; i < rows.length; i++) {

      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/?token=${token}`;

      const qr = await QRCode.toBuffer(url);

      archive.append(qr, { name: `qr-${i + 1}.png` });
    }

    archive.finalize();
  });

});

// --- PDF QR ---
app.get("/print-qrs", async (req,res)=>{

  const doc = new PDFDocument({margin:30});

  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition","inline; filename=qrcodes.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err,rows)=>{

    const perRow = 3;
    const perCol = 4;
    const size = 120;
    const padding = 40;

    let col = 0;
    let row = 0;

    for(let i=0;i<rows.length;i++){

      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/?token=${token}`;

      const qr = await QRCode.toDataURL(url);
      const base64 = qr.replace(/^data:image\/png;base64,/,"");
      const img = Buffer.from(base64,"base64");

      const x = 50 + col * (size + padding);
      const y = 50 + row * (size + 70);

      // QR
      doc.image(img,x,y,{width:size});

      // NUMERO
      doc.fontSize(10);
      doc.text(`QR ${i+1}`, x, y + size + 5, {
        width: size,
        align: "center"
      });

      // CROCI DI TAGLIO
      const offset = 5;

      // alto sinistra
      doc.moveTo(x - offset, y)
         .lineTo(x - offset, y + 15)
         .stroke();

      doc.moveTo(x - offset, y)
         .lineTo(x + 15, y)
         .stroke();

      // alto destra
      doc.moveTo(x + size + offset, y)
         .lineTo(x + size + offset, y + 15)
         .stroke();

      doc.moveTo(x + size + offset, y)
         .lineTo(x + size - 15, y)
         .stroke();

      // basso sinistra
      doc.moveTo(x - offset, y + size)
         .lineTo(x - offset, y + size - 15)
         .stroke();

      doc.moveTo(x - offset, y + size)
         .lineTo(x + 15, y + size)
         .stroke();

      // basso destra
      doc.moveTo(x + size + offset, y + size)
         .lineTo(x + size + offset, y + size - 15)
         .stroke();

      doc.moveTo(x + size + offset, y + size)
         .lineTo(x + size - 15, y + size)
         .stroke();

      col++;

      if(col === perRow){
        col = 0;
        row++;
      }

      if(row === perCol){
        doc.addPage();
        col = 0;
        row = 0;
      }

    }

    doc.end();

  });

});

// --- START SERVER ---
app.listen(PORT, () => {
  console.log("Server attivo su porta", PORT);
});

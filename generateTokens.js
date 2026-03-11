const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");
const path = require("path");

const db = new sqlite3.Database("votes.db");

const PARTICIPANTI = 300; // numero partecipanti

db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY,
      used INTEGER DEFAULT 0
    )
  `);

  for (let i = 0; i < PARTICIPANTI; i++) {
    const token = uuidv4();
    db.run("INSERT INTO tokens(token) VALUES(?)", [token]);

    // Sostituisci "votazione-1" con il tuo dominio Render
    const url = `https://votazione-1.onrender.com/vote.html?token=${token}`;

    // Salva i PNG nella cartella "qrcodes"
    QRCode.toFile(path.join(__dirname, "qrcodes", `qr-${i + 1}.png`), url, (err) => {
      if (err) console.log("Errore QR:", err);
    });
  }

  console.log(`${PARTICIPANTI} token generati!`);
});
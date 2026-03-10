const sqlite3 = require("sqlite3").verbose();
const QRCode = require("qrcode");
const { v4: uuidv4 } = require("uuid");

const db = new sqlite3.Database("votes.db");

const PARTICIPANTI = 100; // numero partecipanti

db.serialize(()=>{

  db.run(`
    CREATE TABLE IF NOT EXISTS tokens(
      token TEXT PRIMARY KEY,
      used INTEGER DEFAULT 0
    )
  `);

  for(let i=0;i<PARTICIPANTI;i++){
    let token = uuidv4();

    db.run("INSERT INTO tokens(token) VALUES(?)",[token]);

    let url = `https://nome-app.onrender.com/vote.html?token=${token}`;

    QRCode.toFile(`qr-${i+1}.png`, url, (err)=>{
      if(err) console.log("Errore QR:", err);
    });
  }

  console.log(`${PARTICIPANTI} token generati!`);

});
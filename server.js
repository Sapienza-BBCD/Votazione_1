const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const QRCode = require("qrcode");

const PORT = process.env.PORT || 3000;

const app = express();
app.use(express.static("public"));
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("votes.db");

const PARTICIPANTI = 300;

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

  db.get("SELECT COUNT(*) AS count FROM tokens", (err, row) => {

    if (err) {
      console.log(err);
      return;
    }

    if (row.count === 0) {

      for (let i = 0; i < PARTICIPANTI; i++) {

        const token = uuidv4();

        db.run(
          "INSERT INTO tokens(token) VALUES(?)",
          [token]
        );

      }

      console.log(`${PARTICIPANTI} token generati sul server`);

    }

  });

});

app.post("/vote", (req, res) => {

  const { token, choice } = req.body;

  db.get(
    "SELECT * FROM tokens WHERE token=?",
    [token],
    (err, row) => {

      if (err) return res.json({ error: "Errore server" });

      if (!row)
        return res.json({ error: "Token non valido" });

      if (row.used === 1)
        return res.json({ error: "Token già usato" });

      db.run(
        "INSERT INTO votes(token, choice) VALUES(?,?)",
        [token, choice]
      );

      db.run(
        "UPDATE tokens SET used=1 WHERE token=?",
        [token]
      );

      res.json({ success: true });

    }
  );

});

app.get("/results", (req, res) => {

  db.all(
    "SELECT choice, COUNT(*) as votes FROM votes GROUP BY choice",
    (err, rows) => {

      if (err) return res.json({ error: "Errore server" });

      res.json(rows);

    }
  );

});
app.get("/tokens", (req, res) => {

  db.all("SELECT token FROM tokens", (err, rows) => {

    if (err) return res.json({error:"errore server"});

    res.json(rows);

  });

});

app.get("/qrcodes", (req, res) => {

  db.all("SELECT token FROM tokens", async (err, rows) => {

    if (err) return res.send("Errore server");

    let html = "<h1>QR Code votazione</h1>";

    for (let i = 0; i < rows.length; i++) {

      const token = rows[i].token;

      const url = `https://votazione-1.onrender.com/vote.html?token=${token}`;

      const qr = await QRCode.toDataURL(url);

      html += `
        <div style="display:inline-block;text-align:center;margin:10px">
          <img src="${qr}" width="150"><br>
          ${i+1}
        </div>
      `;

    }

    res.send(html);

  });

});

app.listen(PORT, () => {
  console.log(`Server attivo su porta ${PORT}`);
});
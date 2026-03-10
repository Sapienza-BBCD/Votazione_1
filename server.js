const express = require("express");
const sqlite3 = require("sqlite3").verbose();
const cors = require("cors");

const app = express();
app.use(express.static("public"));
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("votes.db");

db.serialize(()=>{
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
});

// Votare con token
app.post("/vote",(req,res)=>{
  const {token, choice} = req.body;

  db.get("SELECT * FROM tokens WHERE token=?",[token],(err,row)=>{
    if(!row) return res.json({error:"Token non valido"});
    if(row.used===1) return res.json({error:"Token già usato"});

    db.run("INSERT INTO votes(token,choice) VALUES(?,?)",[token,choice]);
    db.run("UPDATE tokens SET used=1 WHERE token=?",[token]);

    res.json({success:true});
  });
});

// Controllo risultati
app.get("/results",(req,res)=>{
  db.all("SELECT choice, COUNT(*) as votes FROM votes GROUP BY choice",(err,rows)=>{
    res.json(rows);
  });
});

app.listen(3000,()=>console.log("Server attivo su porta 3000"));
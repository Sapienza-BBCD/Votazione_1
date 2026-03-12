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

app.use(express.static("public"));
app.use(express.json());
app.use(cors());

const db = new sqlite3.Database("votes.db");

const PARTICIPANTI = 300;
const MAX_VOTES = 2;

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
      token TEXT PRIMARY KEY
    )
  `);

  db.get("SELECT COUNT(*) as count FROM tokens",(err,row)=>{

    if(row.count===0){

      for(let i=0;i<PARTICIPANTI;i++){
        const token = uuidv4();
        db.run("INSERT INTO tokens(token) VALUES(?)",[token]);
      }

      console.log("Token generati:",PARTICIPANTI);

    }

  });

});


// HOME
app.get("/",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","vote.html"));
});


// VOTO
app.post("/vote",(req,res)=>{

  const {token,choice} = req.body;

  db.get("SELECT * FROM tokens WHERE token=?",[token],(err,row)=>{

    if(err) return res.json({error:"Errore server"});
    if(!row) return res.json({error:"Token non valido"});

    db.get(
      "SELECT COUNT(*) as count FROM votes WHERE token=?",
      [token],
      (err,result)=>{

        if(result.count >= MAX_VOTES){
          return res.json({error:"Hai già usato i tuoi 2 voti"});
        }

        db.run(
          "INSERT INTO votes(token,choice) VALUES(?,?)",
          [token,choice],
          (err)=>{
            if(err) return res.json({error:"Errore server"});
            res.json({success:true});
          }
        );

      }
    );

  });

});


// RISULTATI
app.get("/results",(req,res)=>{

  db.all(
    "SELECT choice, COUNT(*) as votes FROM votes GROUP BY choice",
    (err,rows)=>{
      if(err) return res.json({error:"Errore server"});
      res.json(rows);
    }
  );

});


// ADMIN
app.get("/admin",(req,res)=>{
  res.sendFile(path.join(__dirname,"public","admin.html"));
});


// LISTA TOKEN
app.get("/tokens",(req,res)=>{

  db.all("SELECT token FROM tokens",(err,rows)=>{
    if(err) return res.json({error:"Errore server"});
    res.json(rows);
  });

});


// DOWNLOAD QR ZIP
app.get("/download-qrs",async(req,res)=>{

  res.attachment("qrcodes.zip");

  const archive = archiver("zip");
  archive.pipe(res);

  db.all("SELECT token FROM tokens", async (err,rows)=>{

    for(let i=0;i<rows.length;i++){

      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/?token=${token}`;

      const qr = await QRCode.toBuffer(url);

      archive.append(qr,{
        name:`qr-${i+1}.png`
      });

    }

    archive.finalize();

  });

});


// PDF QR
app.get("/print-qrs", async (req,res)=>{

  const doc = new PDFDocument({margin:30});

  res.setHeader("Content-Type","application/pdf");
  res.setHeader("Content-Disposition","inline; filename=qrcodes.pdf");

  doc.pipe(res);

  db.all("SELECT token FROM tokens", async (err,rows)=>{

    const perRow = 3;
    const size = 150;

    let x = 50;
    let y = 50;
    let count = 0;

    for(let i=0;i<rows.length;i++){

      const token = rows[i].token;
      const url = `https://votazione-1.onrender.com/?token=${token}`;

      const qr = await QRCode.toDataURL(url);

      const base64 = qr.replace(/^data:image\/png;base64,/,"");
      const img = Buffer.from(base64,"base64");

      doc.image(img,x,y,{width:size});

      count++;
      x += 180;

      if(count % perRow === 0){
        x = 50;
        y += 200;
      }

      if(y > 700){
        doc.addPage();
        x = 50;
        y = 50;
      }

    }

    doc.end();

  });

});


// AVVIO SERVER
app.listen(PORT,()=>{
  console.log("Server attivo su porta",PORT);
});
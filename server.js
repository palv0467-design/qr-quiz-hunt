const express = require("express");
const path = require("path");
const Database = require("better-sqlite3");
const QRCode = require("qrcode");
const jwt = require("jsonwebtoken");
const bcrypt = require("bcryptjs");

const app = express();
app.set("trust proxy", 1);
app.use(express.json({ limit: "100kb" }));
app.use(express.static(path.join(__dirname, "public")));

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || "CHANGE_ME_IN_PRODUCTION";
const ADMIN_USERNAME = process.env.ADMIN_USERNAME || "admin";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";

function getBaseUrl(req) {
  const protocol = req.headers["x-forwarded-proto"] || req.protocol;
  const host = req.get("host");
  return `${protocol.split(",")[0].trim()}://${host}`.replace(/\/+$/, "");
}

const db = new Database(path.join(__dirname, "quiz-hunt.db"));
db.pragma("journal_mode = WAL");

db.exec(`
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS questions (
  number INTEGER PRIMARY KEY,
  question TEXT NOT NULL,
  options TEXT NOT NULL,
  answer INTEGER NOT NULL,
  hint TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS contestants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  state TEXT NOT NULL,
  current_qr INTEGER NOT NULL DEFAULT 1,
  finding_deadline INTEGER,
  question_deadline INTEGER,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  disqualified_at INTEGER,
  disqualified_reason TEXT,
  last_seen INTEGER,
  visibility_violations INTEGER NOT NULL DEFAULT 0
);
`);

function setting(key, fallback) {
  const row = db.prepare("SELECT value FROM settings WHERE key=?").get(key);
  return row ? row.value : fallback;
}
function setSetting(key, value) {
  db.prepare("INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
    .run(key, String(value));
}
if (!setting("game_title")) setSetting("game_title", "QR QUIZ HUNT");
if (!setting("finding_seconds")) setSetting("finding_seconds", 120);
if (!setting("question_seconds")) setSetting("question_seconds", 30);
if (!setting("game_enabled")) setSetting("game_enabled", "1");

const defaultQuestions = [
  ["What does UPI stand for?", ["Unified Payments Interface","Universal Payment Internet","User Payment Identity","Unified Banking Interface"], 0, "Look near the main notice board."],
  ["Which technology is commonly used for contactless card payments?", ["NFC","FTP","SMTP","HDMI"], 0, "Find the place where students enter or exit the auditorium."],
  ["What is OTP mainly used for in digital banking?", ["Authentication","Printing","Currency exchange","ATM maintenance"], 0, "Look close to the library entrance."],
  ["Which of these is a digital banking service?", ["Mobile banking","Cheque book binding","Cash sorting","Vault painting"], 0, "Check around the student help desk."],
  ["What is phishing?", ["A fraudulent attempt to obtain sensitive information","A type of ATM","A bank holiday","A payment receipt"], 0, "Look near a common seating area in the lobby."],
  ["What should you do with your banking PIN?", ["Keep it secret","Share it with friends","Post it online","Write it on your phone case"], 0, "Search near the college reception area."],
  ["What is a QR code commonly used for in payments?", ["Encoding payment or transaction information","Increasing Wi-Fi speed","Printing cash","Charging a phone"], 0, "Look near a campus information display."],
  ["Which password is generally safer?", ["A long unique password","123456","password","your first name"], 0, "Check near the entrance to a common student area."],
  ["What is two-factor authentication?", ["Using two different verification factors","Using two bank accounts","Paying twice","Opening two apps"], 0, "Look near the main lobby seating."],
  ["Which action is safest after using mobile banking on a shared device?", ["Log out of the banking session","Save the password in the browser","Leave the account open","Share the OTP"], 0, "FINAL QR: return to the organiser table after completing this question."]
];
const count = db.prepare("SELECT COUNT(*) AS c FROM questions").get().c;
if (!count) {
  const insert = db.prepare("INSERT INTO questions(number,question,options,answer,hint) VALUES(?,?,?,?,?)");
  const tx = db.transaction(() => defaultQuestions.forEach((q, i) => insert.run(i + 1, q[0], JSON.stringify(q[1]), q[2], q[3])));
  tx();
}

function makeId() {
  return require("crypto").randomBytes(12).toString("hex");
}
function signContestant(id) {
  return jwt.sign({ sub: id, role: "contestant" }, JWT_SECRET, { expiresIn: "8h" });
}
function getContestant(req) {
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : req.body?.token || req.query?.token;
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    if (p.role !== "contestant") return null;
    return db.prepare("SELECT * FROM contestants WHERE id=?").get(p.sub) || null;
  } catch { return null; }
}
function adminToken(req) {
  const token = req.headers.authorization?.startsWith("Bearer ")
    ? req.headers.authorization.slice(7)
    : req.body?.token || req.query?.token;
  if (!token) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    return p.role === "admin" ? p : null;
  } catch { return null; }
}
function requireAdmin(req, res, next) {
  if (!adminToken(req)) return res.status(401).json({ error: "Admin authentication required." });
  next();
}
function disqualify(id, reason) {
  db.prepare(`
    UPDATE contestants
    SET state='DISQUALIFIED', disqualified_at=?, disqualified_reason=?, last_seen=?
    WHERE id=? AND state NOT IN ('FINISHED','DISQUALIFIED')
  `).run(Date.now(), reason, Date.now(), id);
}
function publicContestant(c) {
  return {
    id: c.id,
    name: c.name,
    state: c.state,
    currentQr: c.current_qr,
    findingDeadline: c.finding_deadline,
    questionDeadline: c.question_deadline,
    startedAt: c.started_at,
    finishedAt: c.finished_at,
    disqualifiedAt: c.disqualified_at,
    disqualifiedReason: c.disqualified_reason,
    lastSeen: c.last_seen,
    visibilityViolations: c.visibility_violations
  };
}

app.post("/api/auth/admin", (req,res) => {
  const { username, password } = req.body || {};
  if (username !== ADMIN_USERNAME || password !== ADMIN_PASSWORD) return res.status(401).json({error:"Invalid admin login."});
  res.json({ token: jwt.sign({ role:"admin", sub:username }, JWT_SECRET, { expiresIn:"12h" }) });
});

app.post("/api/game/register", (req,res) => {
  if (setting("game_enabled","1") !== "1") return res.status(403).json({error:"The game is currently closed."});
  const name = String(req.body?.name || "").trim().replace(/\s+/g," ");
  if (name.length < 2 || name.length > 40) return res.status(400).json({error:"Enter a name between 2 and 40 characters."});
  const id = makeId();
  const now = Date.now();
  db.prepare(`INSERT INTO contestants(id,name,state,current_qr,started_at,last_seen) VALUES(?,?,'FINDING',1,?,?)`).run(id,name,now,now);
  const token = signContestant(id);
  res.json({ token, contestant: publicContestant(db.prepare("SELECT * FROM contestants WHERE id=?").get(id)), game: getGamePublic() });
});

function getGamePublic() {
  return {
    title: setting("game_title","QR QUIZ HUNT"),
    findingSeconds: Number(setting("finding_seconds",120)),
    questionSeconds: Number(setting("question_seconds",30)),
    totalQr: 10
  };
}

app.get("/api/game/state", (req,res) => {
  const c = getContestant(req);
  if (!c) return res.status(401).json({error:"Session expired. Please restart from the organiser start QR."});
  const now = Date.now();
  if (c.state === "FINDING" && c.finding_deadline && now >= c.finding_deadline) {
    disqualify(c.id, "120-second QR finding timer expired.");
  }
  const fresh = db.prepare("SELECT * FROM contestants WHERE id=?").get(c.id);
  let question = null;
  if (fresh.state === "QUESTION") {
    if (fresh.question_deadline && now >= fresh.question_deadline) {
      disqualify(fresh.id, "30-second question timer expired.");
    } else {
      const q = db.prepare("SELECT number,question,options FROM questions WHERE number=?").get(fresh.current_qr);
      if (q) question = {...q, options:JSON.parse(q.options)};
    }
  }
  const final = db.prepare("SELECT * FROM contestants WHERE id=?").get(c.id);
  res.json({contestant:publicContestant(final), question, game:getGamePublic(), serverNow:Date.now()});
});

app.post("/api/game/scan", (req,res) => {
  const c = getContestant(req);
  if (!c) return res.status(401).json({error:"Invalid session."});
  const qr = Number(req.body?.qr);
  if (!Number.isInteger(qr) || qr < 1 || qr > 10) return res.status(400).json({error:"Invalid QR code."});
  const fresh = db.prepare("SELECT * FROM contestants WHERE id=?").get(c.id);
  const now = Date.now();
  if (fresh.state === "FINDING" && fresh.finding_deadline && now >= fresh.finding_deadline) {
    disqualify(fresh.id, "120-second QR finding timer expired.");
    return res.status(410).json({error:"Time expired. You are disqualified."});
  }
  if (fresh.state !== "FINDING") return res.status(409).json({error:"You cannot scan a QR code at this stage."});
  if (qr !== fresh.current_qr) return res.status(409).json({error:`Wrong QR. You must scan QR ${fresh.current_qr}.`});
  const q = db.prepare("SELECT number,question,options FROM questions WHERE number=?").get(qr);
  const deadline = now + Number(setting("question_seconds",30))*1000;
  db.prepare("UPDATE contestants SET state='QUESTION', question_deadline=?, last_seen=? WHERE id=?").run(deadline,now,fresh.id);
  res.json({ok:true, question:{...q,options:JSON.parse(q.options)}, contestant:publicContestant(db.prepare("SELECT * FROM contestants WHERE id=?").get(fresh.id)), serverNow:now});
});

app.post("/api/game/answer", (req,res) => {
  const c = getContestant(req);
  if (!c) return res.status(401).json({error:"Invalid session."});
  const choice = Number(req.body?.choice);
  const fresh = db.prepare("SELECT * FROM contestants WHERE id=?").get(c.id);
  const now = Date.now();
  if (fresh.state !== "QUESTION") return res.status(409).json({error:"No active question."});
  if (fresh.question_deadline && now >= fresh.question_deadline) {
    disqualify(fresh.id, "30-second question timer expired.");
    return res.status(410).json({error:"Time expired. You are disqualified."});
  }
  const q = db.prepare("SELECT * FROM questions WHERE number=?").get(fresh.current_qr);
  if (!q) return res.status(500).json({error:"Question not found."});
  if (choice !== q.answer) {
    disqualify(fresh.id, "Incorrect answer.");
    return res.status(409).json({error:"Incorrect answer. You are disqualified."});
  }
  if (fresh.current_qr === 10) {
    db.prepare("UPDATE contestants SET state='FINISHED', finished_at=?, question_deadline=NULL, last_seen=? WHERE id=?").run(now,now,fresh.id);
    return res.json({ok:true, finished:true, contestant:publicContestant(db.prepare("SELECT * FROM contestants WHERE id=?").get(fresh.id))});
  }
  const next = fresh.current_qr + 1;
  const findingDeadline = now + Number(setting("finding_seconds",120))*1000;
  db.prepare("UPDATE contestants SET state='FINDING', current_qr=?, finding_deadline=?, question_deadline=NULL, last_seen=? WHERE id=?")
    .run(next,findingDeadline,now,fresh.id);
  const hint = db.prepare("SELECT hint FROM questions WHERE number=?").get(next).hint;
  res.json({ok:true, finished:false, hint, nextQr:next, contestant:publicContestant(db.prepare("SELECT * FROM contestants WHERE id=?").get(fresh.id))});
});

app.post("/api/game/heartbeat", (req,res) => {
  const c = getContestant(req);
  if (!c) return res.status(401).json({error:"Invalid session."});
  db.prepare("UPDATE contestants SET last_seen=? WHERE id=?").run(Date.now(),c.id);
  res.json({ok:true});
});

app.post("/api/game/visibility", (req,res) => {
  const c = getContestant(req);
  if (!c) return res.status(401).json({error:"Invalid session."});
  const fresh = db.prepare("SELECT * FROM contestants WHERE id=?").get(c.id);
  if (fresh.state === "FINISHED" || fresh.state === "DISQUALIFIED") return res.json({ok:true,state:fresh.state});
  const violations = fresh.visibility_violations + 1;
  db.prepare("UPDATE contestants SET visibility_violations=?, last_seen=? WHERE id=?").run(violations,Date.now(),c.id);
  // First backgrounding event is recorded as a warning; second event disqualifies.
  if (violations >= 2) {
    disqualify(c.id, "Game page was left/backgrounded twice.");
    return res.json({ok:true,disqualified:true});
  }
  res.json({ok:true,warning:true,violations});
});

app.get("/api/admin/overview", requireAdmin, (req,res) => {
  const rows = db.prepare("SELECT * FROM contestants ORDER BY started_at DESC").all();
  const counts = {total:rows.length, active:rows.filter(x=>["FINDING","QUESTION"].includes(x.state)).length, finished:rows.filter(x=>x.state==="FINISHED").length, disqualified:rows.filter(x=>x.state==="DISQUALIFIED").length};
  res.json({counts, contestants:rows.map(publicContestant), game:getGamePublic()});
});

app.get("/api/admin/questions", requireAdmin, (req,res) => {
  const rows = db.prepare("SELECT * FROM questions ORDER BY number").all();
  res.json(rows.map(q=>({...q,options:JSON.parse(q.options)})));
});

app.put("/api/admin/questions/:number", requireAdmin, (req,res) => {
  const n = Number(req.params.number);
  const {question, options, answer, hint} = req.body || {};
  if (!Number.isInteger(n)||n<1||n>10||typeof question!=="string"||!Array.isArray(options)||options.length!==4||!Number.isInteger(Number(answer))||Number(answer)<0||Number(answer)>3||typeof hint!=="string")
    return res.status(400).json({error:"Invalid question data."});
  db.prepare("UPDATE questions SET question=?,options=?,answer=?,hint=? WHERE number=?").run(question.trim(),JSON.stringify(options.map(String)),Number(answer),hint.trim(),n);
  res.json({ok:true});
});

app.get("/api/admin/settings", requireAdmin, (req,res) => res.json(getGamePublic()));
app.put("/api/admin/settings", requireAdmin, (req,res) => {
  const finding = Math.max(5,Math.min(900,Number(req.body?.findingSeconds)));
  const question = Math.max(5,Math.min(300,Number(req.body?.questionSeconds)));
  const title = String(req.body?.title || "QR QUIZ HUNT").trim().slice(0,60);
  if (!Number.isFinite(finding)||!Number.isFinite(question)) return res.status(400).json({error:"Invalid timers."});
  setSetting("finding_seconds",finding); setSetting("question_seconds",question); setSetting("game_title",title);
  res.json(getGamePublic());
});
app.post("/api/admin/game/toggle", requireAdmin, (req,res) => {
  const enabled = req.body?.enabled ? "1" : "0";
  setSetting("game_enabled",enabled);
  res.json({enabled:enabled==="1"});
});
app.post("/api/admin/disqualify/:id", requireAdmin, (req,res) => {
  const c = db.prepare("SELECT * FROM contestants WHERE id=?").get(req.params.id);
  if (!c) return res.status(404).json({error:"Contestant not found."});
  disqualify(c.id,"Disqualified by organiser.");
  res.json({ok:true});
});
app.post("/api/admin/reset", requireAdmin, (req,res) => {
  db.prepare("DELETE FROM contestants").run();
  res.json({ok:true});
});

app.get("/api/admin/qr/:number.png", requireAdmin, async (req,res) => {
  const n = Number(req.params.number);
  if (!Number.isInteger(n)||n<1||n>10) return res.status(400).end();
  const url = `${getBaseUrl(req)}/?qr=${n}`;
  res.type("png");
  try { const buffer = await QRCode.toBuffer(url,{width:700,margin:2}); res.send(buffer); }
  catch { res.status(500).end(); }
});

app.get("/api/admin/start-qr.png", requireAdmin, async (req,res) => {
  const url = `${getBaseUrl(req)}/?start=1`;
  res.type("png");
  try { const buffer = await QRCode.toBuffer(url,{width:700,margin:2}); res.send(buffer); }
  catch { res.status(500).end(); }
});

app.get("/api/admin/qr-links", requireAdmin, (req,res) => {
  const baseUrl = getBaseUrl(req);
  res.json({
    start:`${baseUrl}/?start=1`,
    qr:Array.from({length:10},(_,i)=>({number:i+1,url:`${baseUrl}/?qr=${i+1}`}))
  });
});

app.get("*", (req,res) => res.sendFile(path.join(__dirname,"public","index.html")));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`QR Quiz Hunt running on port ${PORT}`);
});

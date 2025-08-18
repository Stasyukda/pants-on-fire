// SparkSchool Game Server — MVP "quiz"
// Екрани: / (домашня), /host (вчитель), /player (учень), /screen (проектор)

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

const io = new Server(server, { cors: { origin: "*", methods: ["GET", "POST"] } });

/* ======================= ІГРОВА МОДЕЛЬ =======================

room = {
  players: Map<socketId,string>,
  scores: Map<string,number>,
  state: 'lobby'|'question'|'reveal',
  question: string|null,
  choices: string[],
  correct: number|null,
  endsAt: number,
  answers: Map<socketId,{name,idx,at}>,
  timer: NodeJS.Timeout|null
}
*/
const rooms = new Map();
const getRoom = (code) => {
  if (!rooms.has(code)) {
    rooms.set(code, {
      players: new Map(),
      scores: new Map(),
      state: "lobby",
      question: null,
      choices: [],
      correct: null,
      endsAt: 0,
      answers: new Map(),
      timer: null,
    });
  }
  return rooms.get(code);
};
const presenceList = (room) => {
  const set = io.sockets.adapter.rooms.get(room);
  if (!set) return [];
  const list = [];
  for (const id of set) {
    const s = io.sockets.sockets.get(id);
    if (s?.data?.name) list.push({ id, name: s.data.name });
  }
  return list;
};
const broadcastScoreboard = (roomCode) => {
  const R = getRoom(roomCode);
  const rows = [...R.scores.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  io.to(roomCode).emit("scoreboard", rows);
};
const stopTimer = (roomCode) => {
  const R = getRoom(roomCode);
  if (R.timer) { clearInterval(R.timer); R.timer = null; }
};

/* ======================= SOCKET.IO ======================= */
io.on("connection", (socket) => {
  // player:join
  socket.on("player:join", ({ room, name }) => {
    if (!room) return;
    const nick = (name || "Student").toString().slice(0, 40).trim();
    socket.join(room);
    socket.data.room = room;
    socket.data.name = nick;
    const R = getRoom(room);
    R.players.set(socket.id, nick);
    if (!R.scores.has(nick)) R.scores.set(nick, 0);

    io.to(room).emit("system", { type: "join", text: `${nick} приєднався` });
    io.to(room).emit("presence", presenceList(room));
    broadcastScoreboard(room);

    if (R.state === "question") {
      socket.emit("question", {
        question: R.question,
        choices: R.choices,
        endsIn: Math.max(0, Math.ceil((R.endsAt - Date.now()) / 1000)),
      });
    } else if (R.state === "reveal") {
      socket.emit("reveal", { correct: R.correct });
    }
  });

  // відповідь учня
  socket.on("player:answer", ({ idx }) => {
    const room = socket.data?.room;
    const name = socket.data?.name || "Student";
    if (!room) return;
    const R = getRoom(room);
    if (R.state !== "question") return;
    if (Date.now() > R.endsAt) return;
    if (R.answers.has(socket.id)) return;

    const choice = Number(idx);
    R.answers.set(socket.id, { name, idx: choice, at: Date.now() });
    socket.emit("answer:ack", { ok: true, idx: choice });
  });

  // host:create
  socket.on("host:create", ({ room }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = "HOST";
    getRoom(room);
    socket.emit("host:ready", { room });
    io.to(room).emit("presence", presenceList(room));
    broadcastScoreboard(room);
  });

  // host:start
  socket.on("host:start", ({ room, question, choices, duration }) => {
    if (!room || !question || !Array.isArray(choices) || choices.length < 2) return;
    const R = getRoom(room);
    stopTimer(room);
    R.state = "question";
    R.question = question.toString().slice(0, 300);
    R.choices = choices.map((c) => c.toString().slice(0, 120));
    R.correct = null;
    R.answers.clear();

    const sec = Math.max(5, Math.min(120, Number(duration || 20)));
    R.endsAt = Date.now() + sec * 1000;

    io.to(room).emit("question", { question: R.question, choices: R.choices, endsIn: sec });

    R.timer = setInterval(() => {
      const left = Math.ceil((R.endsAt - Date.now()) / 1000);
      io.to(room).emit("tick", Math.max(0, left));
      if (left <= 0) {
        stopTimer(room);
        io.to(room).emit("timeup");
      }
    }, 1000);
  });

  // host:reveal
  socket.on("host:reveal", ({ room, correct }) => {
    if (!room) return;
    const R = getRoom(room);
    stopTimer(room);
    R.state = "reveal";
    R.correct = Number(correct);
    for (const { name, idx } of R.answers.values()) {
      if (idx === R.correct) R.scores.set(name, (R.scores.get(name) || 0) + 1);
    }
    io.to(room).emit("reveal", { correct: R.correct });
    broadcastScoreboard(room);
  });

  // host:next
  socket.on("host:next", ({ room }) => {
    if (!room) return;
    const R = getRoom(room);
    stopTimer(room);
    R.state = "lobby";
    R.question = null;
    R.choices = [];
    R.correct = null;
    R.endsAt = 0;
    R.answers.clear();
    io.to(room).emit("system", { type: "info", text: "Новий раунд скоро" });
  });

  // вихід
  socket.on("disconnect", () => {
    const room = socket.data?.room;
    const name = socket.data?.name;
    if (room) {
      const R = getRoom(room);
      R.players.delete(socket.id);
      io.to(room).emit("system", { type: "leave", text: `${name} відключився` });
      io.to(room).emit("presence", presenceList(room));
    }
  });
});

/* ======================= CSS ======================= */
const baseCSS = `
:root{--bg:#0f1226;--text:#e8eef6;--muted:#9fb3d8;--accent:#ffb300;--card:#171a34;--ok:#22c55e;--err:#ef4444}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 800px at 80% -10%,#2a2f63 0%,rgba(15,18,38,.6) 60%),var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1000px;margin:32px auto;padding:16px}
.card{background:rgba(20,26,48,.6);border:1px solid rgba(255,255,255,.06);border-radius:14px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
.card .section{padding:12px 0}
.card .section + .section{padding-top:16px}
h1,h2,h3{margin:0 0 10px 0} .muted{color:var(--muted)}
.grid{display:grid;gap:16px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(min-width:860px){.grid-2.wide-cols{grid-template-columns:1.2fr .8fr}}
label{font-size:.85rem;color:var(--muted)}
input,textarea,select{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0b1220;color:#fff}
.btn{padding:.7rem 1rem;border:0;border-radius:12px;background:linear-gradient(135deg,#ffb300,#ff6f00);color:#1b1200;font-weight:800;cursor:pointer}
.btn.btn-primary{background:linear-gradient(135deg,#ffb300,#ff6f00)}
.btn.btn-ghost{background:rgba(255,255,255,.08);color:#fff}
.btn.sec{background:#0ea5e9;color:#001018}
.badge{display:inline-flex;gap:.5rem;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:.35rem .6rem;border-radius:999px;color:var(--muted)}
.log-box{min-height:160px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.35;white-space:pre-wrap;background:rgba(10,12,24,.55);border:1px dashed rgba(255,255,255,.12);border-radius:12px;padding:12px;overflow:auto}
.choices{display:grid;gap:10px;margin-top:12px}
.choice{border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px;background:#0b1220;cursor:pointer}
.choice.correct{outline:2px solid var(--ok)} .choice.wrong{opacity:.5}
.score{display:flex;flex-direction:column;gap:6px}
.row{display:grid;gap:12px;grid-template-columns:1fr 60px}
.btn-row{display:flex;gap:10px;flex-wrap:wrap}
.actions-3{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.join-row{display:grid;grid-template-columns:1fr 1fr auto;gap:10px;align-items:center}
.share-link{display:flex;align-items:center;gap:10px;margin-top:10px;flex-wrap:wrap}
.share-link input[type="text"]{flex:1 1 260px;min-width:0}
.layout-host,.layout-player{display:grid;grid-template-columns:1fr 1fr;gap:16px}
.player-card{order:1}.events-card{order:2}
@media (max-width:768px){
  .grid-2,.layout-host,.layout-player{grid-template-columns:1fr}
  .player-card{order:1}.events-card{order:2}
  .join-row{grid-template-columns:1fr}
  .btn,.btn-primary,.btn-ghost{width:100%}
  .actions-3{grid-template-columns:1fr}
  .share-link{flex-direction:column;align-items:stretch}
  h2,h3{font-size:18px}
}
@media (max-width:380px){body{font-size:15px} .log-box{font-size:12.5px}}
/* Шапка панелі вчителя */
.toolbar{display:grid;grid-template-columns:140px 1fr;gap:16px;align-items:flex-start}
.toolbar-qr{width:140px;height:140px;border-radius:12px;background:#fff;justify-self:start}
.toolbar-row{display:grid;grid-template-columns:1fr auto;gap:10px}
.toolbar-row input{width:100%}.toolbar-row .btn{white-space:nowrap}
@media (max-width:360px){
  .toolbar{grid-template-columns:1fr}
  .toolbar-qr{justify-self:center;width:120px;height:120px}
  .toolbar-row{grid-template-columns:1fr}
  .toolbar-row .btn{width:100%}
}
/* Домашні посилання як кнопки */
.btn-link{display:inline-block;text-decoration:none;color:#1b1200;background:linear-gradient(135deg,#ffb300,#ff6f00);padding:.7rem 1rem;border-radius:12px;font-weight:800}
.btn-link.sec{background:#0ea5e9;color:#001018}
`;

/* ======================= ROUTES ======================= */

// Домашня
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>SparkSchool Game</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${baseCSS}</style>

  <div class="wrap grid">
    <section class="card">
      <h1>⚡ SparkSchool • Quiz MVP</h1>
      <p class="muted">Оберіть екран:</p>
      <p class="section">
        <a class="btn-link" href="/host">Host (вчитель)</a>
        <a class="btn-link sec" href="/player">Player (учень)</a>
        <a class="btn-link sec" href="/screen">Screen (проектор)</a>
      </p>
    </section>

    <section class="card">
      <h3>Як працює</h3>
      <ol>
        <li>Вчитель відкриває <b>/host</b> і створює кімнату (<code>class-1</code>).</li>
        <li>Учні відкривають <b>/player</b>, вводять код/ім’я або сканують QR.</li>
        <li>Host задає питання, варіанти, запускає таймер; потім — Reveal.</li>
        <li>Проектор <b>/screen?room=class-1</b> показує питання, таймер і таблицю балів.</li>
      </ol>
    </section>
  </div>`);
});

// Host UI
app.get("/host", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>Host • SparkSchool</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${baseCSS}</style>

  <div class="wrap">
    <section class="card">
      <h2>Панель вчителя</h2>

      <!-- ВЕРХНІЙ БЛОК: QR + керування праворуч -->
      <div class="section">
        <canvas id="qrCanvas" width="140" height="140" class="toolbar-qr"></canvas>
        <div>
          <div class="toolbar-row" style="margin-bottom:10px">
            <input id="hostRoom" placeholder="Кімната" value="class-1" />
            <button class="btn btn-primary" id="hostJoinBtn">Створити / Підключитись</button>
            <input id="shareUrl" type="text" readonly />
            <button class="btn" id="copyLink">Копіювати</button>
          </div>
        </div>
      </div>

      <h3 class="section" style="padding-top:0">Нове питання</h3>
      <div class="section">
        <input id="qText" placeholder="Питання (напр.: Як перекладається слово lightning?)" />
        <div class="btn-row" style="margin-top:10px">
          <input id="optA" placeholder="Варіант A" />
          <input id="optB" placeholder="Варіант B" />
        </div>
        <div class="btn-row" style="margin-top:10px">
          <input id="optC" placeholder="Варіант C" />
          <input id="optD" placeholder="Варіант D" />
        </div>
        <div class="btn-row" style="margin-top:10px">
          <select id="right" aria-label="Правильна відповідь">
            <option value="0">A</option><option value="1">B</option>
            <option value="2">C</option><option value="3">D</option>
          </select>
          <input id="time" inputmode="numeric" pattern="\\d*" placeholder="Таймер (сек)" value="20" />
        </div>
        <div class="actions-3" style="margin-top:12px">
          <button class="btn btn-primary" id="btnStart">Start</button>
          <button class="btn" id="btnReveal">Reveal</button>
          <button class="btn" id="btnNext">Next</button>
        </div>
      </div>

      <h3 class="section">Стан</h3>
      <div class="section muted" id="hostState">Таймер: 0 • Гравців: 0</div>
      <h3 class="section">Учасники</h3>
      <ul id="hostUsers" class="card" style="min-height:56px; padding:8px"></ul>
      <h3 class="section">Події</h3>
      <div id="hostLog" class="log-box"></div>
    </section>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
  <script>
    const $ = (id)=>document.getElementById(id);
    const origin = location.origin.replace(/\\/$/,"");
    const socket = io(origin, { transports: ["websocket","polling"] });
    let currentRoom = null;

    const logBox = ()=>document.getElementById('hostLog');
    function log(m){ const box = logBox(); box.innerHTML += m+"\\n"; box.scrollTop = box.scrollHeight; }

    function buildPlayerLink(){
      const room = (document.getElementById('hostRoom')?.value || 'class-1').trim();
      return \`\${location.origin}/player?room=\${encodeURIComponent(room)}\`;
    }
    function updateShare(){
      const url = buildPlayerLink();
      const share = document.getElementById('shareUrl');
      const canvas = document.getElementById('qrCanvas');
      if (share) share.value = url;
      if (canvas) QRCode.toCanvas(canvas, url, { width: 140 }, e=>e&&console.error(e));
    }
    document.getElementById('hostRoom')?.addEventListener('input', updateShare);
    document.getElementById('copyLink')?.addEventListener('click', ()=>{
      const share = document.getElementById('shareUrl');
      share.select(); document.execCommand('copy');
    });
    document.addEventListener('DOMContentLoaded', updateShare);

    function refreshPresence(list){
      $('hostState').textContent = "Таймер: 0 • Гравців: " + list.length;
      $('hostUsers').innerHTML = list.map(p=>"<li>"+p.name+"</li>").join("");
    }

    $('hostJoinBtn').onclick = ()=>{
      currentRoom = $('hostRoom').value.trim() || 'class-1';
      socket.emit('host:create', { room: currentRoom });
      updateShare();
      log("✓ Підключено як HOST до " + currentRoom);
    };

    $('btnStart').onclick = ()=>{
      if (!currentRoom) return alert("Спершу створіть/виберіть кімнату");
      const q = $('qText').value.trim();
      const choices = [ $('optA').value, $('optB').value, $('optC').value, $('optD').value ]
        .map(s=>s.trim()).filter(Boolean);
      const dur = parseInt($('time').value||"20",10);
      if (!q || choices.length < 2) return alert("Питання і щонайменше 2 варіанти!");
      socket.emit("host:start", { room: currentRoom, question: q, choices, duration: dur });
      log("▶ Старт питання");
    };

    $('btnReveal').onclick = ()=>{
      if (!currentRoom) return;
      const idx = parseInt($('right').value||"0",10);
      socket.emit("host:reveal", { room: currentRoom, correct: idx });
      log("👁 Reveal: " + idx);
    };

    $('btnNext').onclick = ()=>{
      if (!currentRoom) return;
      socket.emit("host:next", { room: currentRoom });
      log("↻ Next round");
    };

    socket.on("host:ready", ({room})=>{ currentRoom = room; updateShare(); });
    socket.on("presence", refreshPresence);
    socket.on("system", (e)=>log("• " + e.text));
    socket.on("tick", (sec)=>{ /* можна виводити у hostState */ });
    socket.on("timeup", ()=>log("⏰ Час вийшов"));
  </script>`);
});

// Player UI
app.get("/player", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>Player • SparkSchool</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${baseCSS}</style>

  <div class="wrap grid-2">
    <section class="card player-card">
      <h3>Player</h3>
      <div class="join-row">
        <input id="room" placeholder="Кімната" value="class-1" />
        <input id="user" placeholder="Ім’я" />
        <button class="btn btn-primary" id="joinBtn">Join</button>
      </div>
      <p class="muted">Після Join чекайте на питання від вчителя…</p>
      <div id="stage" class="section"></div>
    </section>

    <section class="card events-card">
      <h3>Події</h3>
      <div id="playerLog" class="log-box"></div>
      <h3 class="section">Бали</h3>
      <div id="playerScore" class="card" style="min-height:56px"></div>
    </section>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const $ = (id)=>document.getElementById(id);
    const origin = location.origin.replace(/\\/$/,"");
    const socket = io(origin, { transports:["websocket","polling"] });

    // room з query/hash
    const hash = location.hash.match(/room=([^&]+)/);
    if (hash) $('room').value = decodeURIComponent(hash[1]);

    const log = (m)=>{ const el=$('playerLog'); el.innerHTML += m+"\\n"; el.scrollTop=el.scrollHeight; }

    $('joinBtn').onclick = ()=>{
      const room = $('room').value.trim();
      const name = $('user').value.trim() || "Student";
      if (!room) return alert("Введіть кімнату");
      socket.emit("player:join", { room, name });
      log("✓ Join " + room + " як " + name);
    };

    socket.on("question", ({question,choices,endsIn})=>{
      $('stage').innerHTML = \`
        <div class="badge">Час: <span id="t">\${endsIn}</span> s</div>
        <h2>\${question}</h2>
        <div class="choices">\${choices.map((c,i)=>'<button class="choice" data-i="'+i+'">'+c+'</button>').join('')}</div>
      \`;
      document.querySelectorAll('.choice').forEach(btn=>{
        btn.onclick = ()=>{
          const idx = Number(btn.dataset.i);
          socket.emit("player:answer", { idx });
          btn.classList.add("choice","correct");
        };
      });
    });
    socket.on("tick",(sec)=>{ const t=$('t'); if(t) t.textContent=sec; });
    socket.on("timeup",()=>log("⏰ Час вийшов"));

    socket.on("reveal", ({correct})=>{
      const btns = document.querySelectorAll('.choice');
      btns.forEach((b,i)=>{ if (i===correct) b.classList.add('correct'); else b.classList.add('wrong'); });
      log("✅ Правильна: " + correct);
    });
    socket.on("scoreboard",(rows)=>{
      $('playerScore').innerHTML = rows.map(r=>\`
        <div class="row"><div>\${r.name}</div><div style="text-align:right">\${r.score}</div></div>
      \`).join('');
    });
    socket.on("system",(e)=>log("• " + e.text));
    socket.on("answer:ack",()=>log("📨 Відповідь надіслано"));
  </script>`);
});

// Screen (projector)
app.get("/screen", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>Screen • SparkSchool</title>
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <style>${baseCSS}</style>

  <div class="wrap">
    <div class="card">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
        <h1 id="qq">Очікуємо на питання…</h1>
        <div class="timer" id="tt">—</div>
      </div>
      <div id="choices" class="choices" style="grid-template-columns:1fr 1fr"></div>
    </div>
    <div class="card">
      <h3>Таблиця балів</h3>
      <div id="board" class="score"></div>
    </div>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const $ = (id)=>document.getElementById(id);
    const origin = location.origin.replace(/\\/$/,"");
    const socket = io(origin, { transports:["websocket","polling"] });

    const params = new URLSearchParams(location.search);
    let room = params.get("room");
    if (!room) {
      const m = location.hash.match(/room=([^&]+)/);
      if (m) room = decodeURIComponent(m[1]);
    }
    if (!room) room = "class-1";

    socket.emit("player:join", { room, name: "Screen" });

    socket.on("question", ({question,choices})=>{
      $("qq").textContent = question;
      $("choices").innerHTML = choices.map((c,i)=>\`<div class="choice" id="ch\${i}">\${String.fromCharCode(65+i)}. \${c}</div>\`).join('');
      document.querySelectorAll('.choice').forEach(el=>el.classList.remove('correct','wrong'));
    });
    socket.on("tick",(sec)=>{ $("tt").textContent = sec>0 ? sec : "—"; });
    socket.on("reveal", ({correct})=>{
      document.querySelectorAll('.choice').forEach((el,i)=>{
        if (i===correct) el.classList.add('correct'); else el.classList.add('wrong');
      });
    });
    socket.on("scoreboard",(rows)=>{
      $("board").innerHTML = rows.map(r=>\`
        <div class="row"><div>\${r.name}</div><div style="text-align:right">\${r.score}</div></div>
      \`).join('');
    });
  </script>`);
});

// health
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));

/* ======================= START ======================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Game server on http://localhost:${PORT}`));

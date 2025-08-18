// SparkSchool Game Server — Quiz MVP (clean build)

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

/* ================= In-memory game model =================
room = {
  players : Map<socketId,string>,
  scores  : Map<string,number>,
  state   : 'lobby'|'question'|'reveal',
  question: string|null,
  choices : string[],
  correct : number|null,
  endsAt  : number,       // ms
  answers : Map<socketId,{name,idx,at}>,
  timer   : NodeJS.Timeout|null
}
========================================================= */
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
const broadcastScoreboard = (room) => {
  const R = getRoom(room);
  const rows = [...R.scores.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  io.to(room).emit("scoreboard", rows);
};
const stopTimer = (room) => {
  const R = getRoom(room);
  if (R.timer) clearInterval(R.timer);
  R.timer = null;
};

/* ================= Socket.IO ================= */
io.on("connection", (socket) => {
  // player join
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

  // player answer
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

  // host create / join
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

  // host start
  socket.on("host:start", ({ room, question, choices, duration }) => {
    if (!room || !question || !Array.isArray(choices) || choices.length < 2)
      return;
    const R = getRoom(room);
    stopTimer(room);
    R.state = "question";
    R.question = question.toString().slice(0, 300);
    R.choices = choices.map((c) => c.toString().slice(0, 120));
    R.correct = null;
    R.answers.clear();

    const sec = Math.max(5, Math.min(120, Number(duration || 20)));
    R.endsAt = Date.now() + sec * 1000;

    io.to(room).emit("question", {
      question: R.question,
      choices: R.choices,
      endsIn: sec,
    });

    R.timer = setInterval(() => {
      const left = Math.ceil((R.endsAt - Date.now()) / 1000);
      io.to(room).emit("tick", Math.max(0, left));
      if (left <= 0) {
        stopTimer(room);
        io.to(room).emit("timeup");
      }
    }, 1000);
  });

  // host reveal
  socket.on("host:reveal", ({ room, correct }) => {
    if (!room) return;
    const R = getRoom(room);
    stopTimer(room);
    R.state = "reveal";
    R.correct = Number(correct);
    for (const { name, idx } of R.answers.values()) {
      if (idx === R.correct) {
        R.scores.set(name, (R.scores.get(name) || 0) + 1);
      }
    }
    io.to(room).emit("reveal", { correct: R.correct });
    broadcastScoreboard(room);
  });

  // host next
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

  // disconnect / leave
  const leave = (type) => {
    const room = socket.data?.room;
    const name = socket.data?.name;
    if (!room) return;
    const R = getRoom(room);
    R.players.delete(socket.id);
    io.to(room).emit("system", { type, text: `${name} вийшов` });
    io.to(room).emit("presence", presenceList(room));
  };
  socket.on("player:leave", () => leave("leave"));
  socket.on("disconnect", () => leave("leave"));
});

/* ================= Shared CSS ================= */
const baseCSS = `
:root{--bg:#0f1226;--text:#e8eef6;--muted:#9fb3d8;--accent:#ffb300;--ok:#22c55e;--err:#ef4444}
*{box-sizing:border-box}
body{margin:0;background:radial-gradient(1200px 800px at 80% -10%,#2a2f63 0%,rgba(15,18,38,.6) 60%),#0f1226;color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1000px;margin:32px auto;padding:16px}
.card{background:rgba(20,26,48,.6);border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:16px;box-shadow:0 6px 18px rgba(0,0,0,.25)}
h1,h2,h3{margin:0 0 12px} .muted{color:var(--muted)}
a.btn,button.btn{display:inline-flex;align-items:center;justify-content:center;gap:8px;text-decoration:none}
.btn{padding:.8rem 1rem;border:0;border-radius:12px;background:linear-gradient(135deg,#ffb300,#ff6f00);color:#1b1200;font-weight:800;cursor:pointer}
.btn.sec{background:#0ea5e9;color:#001018}
input,textarea,select{width:100%;padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0b1220;color:#fff}
.log-box{min-height:160px;font-family:ui-monospace,Consolas,monospace;font-size:13px;line-height:1.35;white-space:pre-wrap;background:rgba(10,12,24,.55);border:1px dashed rgba(255,255,255,.12);border-radius:12px;padding:12px;overflow:auto}
.choices{display:grid;gap:10px}
.choice{border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px;background:#0b1220;cursor:pointer}
.choice.correct{outline:2px solid var(--ok)} .choice.wrong{opacity:.55}
.score .row{display:grid;grid-template-columns:1fr 60px;gap:10px}
.grid{display:grid;gap:16px}
.grid-2{display:grid;grid-template-columns:1fr 1fr;gap:16px}
@media(min-width:860px){.grid-2.wide-cols{grid-template-columns:1.2fr .8fr}}
/* ===== Host toolbar ===== */
.toolbar{display:grid;grid-template-columns:140px 1fr;gap:20px;align-items:start;margin:6px 0 14px}
.toolbar-qr{width:140px;height:140px;border-radius:12px;background:#fff;justify-self:start}
.toolbar-controls{display:flex;flex-direction:column;gap:12px}
.toolbar .row-2{display:grid;grid-template-columns:1fr auto;gap:10px}
.toolbar .btn{white-space:nowrap}
@media(max-width:480px){.toolbar{grid-template-columns:1fr}.toolbar-qr{justify-self:center;width:120px;height:120px}.toolbar .row-2{grid-template-columns:1fr}.toolbar .btn{width:100%}}
/* Mobile tone */
@media(max-width:768px){h1,h2,h3{font-size:20px}}
`;

/* ================= Pages ================= */

// Home
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>SparkSchool • Quiz MVP</title>
<style>${baseCSS}</style>

<div class="wrap grid">
  <section class="card">
    <h1>⚡ SparkSchool • Quiz MVP</h1>
    <p class="muted">Оберіть екран:</p>
    <p style="display:flex;gap:10px;flex-wrap:wrap">
      <a class="btn" href="/host">Host (вчитель)</a>
      <a class="btn sec" href="/player">Player (учень)</a>
      <a class="btn sec" href="/screen">Screen (проектор)</a>
    </p>
  </section>

  <section class="card">
    <h3>Як працює</h3>
    <ol>
      <li>Вчитель відкриває <b>/host</b> і створює кімнату (наприклад, <code>class-1</code>).</li>
      <li>Учні відкривають <b>/player</b>, вводять код/ім’я або сканують QR.</li>
      <li>Host задає питання, варіанти та запускає таймер; потім — Reveal.</li>
      <li>Проектор <b>/screen?room=class-1</b> показує питання, таймер і таблицю балів.</li>
    </ol>
  </section>
</div>`);
});

// Host
app.get("/host", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Панель вчителя • SparkSchool</title>
<style>${baseCSS}</style>

<div class="wrap">
  <section class="card">
    <h2>Панель вчителя</h2>

    <!-- Toolbar -->
    <div class="toolbar">
      <canvas id="qrCanvas" width="140" height="140" class="toolbar-qr"></canvas>

      <div class="toolbar-controls">
        <div class="row-2">
          <input id="hostRoom" placeholder="Кімната" value="class-1"/>
          <button class="btn" id="hostJoinBtn">Створити / Підключитись</button>
        </div>

        <div class="row-2">
          <input id="shareUrl" type="text" readonly/>
          <button class="btn sec" id="copyLink">Копіювати</button>
        </div>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Нове питання</h2>
    <div style="display:flex;flex-direction:column;gap:10px">
      <input id="qText" placeholder="Питання (напр.: Як перекладається слово lightning?)"/>
      <input id="optA" placeholder="Варіант A"/>
      <input id="optB" placeholder="Варіант B"/>
      <input id="optC" placeholder="Варіант C"/>
      <input id="optD" placeholder="Варіант D"/>
      <div class="grid" style="grid-template-columns:1fr 1fr;gap:10px">
        <input id="time" inputmode="numeric" pattern="\\d*" value="20" placeholder="Таймер (сек)"/>
        <select id="right">
          <option value="0">Правильна: A (0)</option>
          <option value="1">Правильна: B (1)</option>
          <option value="2">Правильна: C (2)</option>
          <option value="3">Правильна: D (3)</option>
        </select>
      </div>
      <div class="grid" style="grid-template-columns:1fr;gap:10px">
        <button class="btn" id="btnStart">Start</button>
        <button class="btn" id="btnReveal">Reveal</button>
        <button class="btn" id="btnNext">Next</button>
      </div>
    </div>
  </section>

  <section class="card">
    <h2>Стан</h2>
    <div class="muted" id="hostState">Таймер: <span id="timer">—</span> • Гравців: <span id="pcount">0</span></div>
    <h3 style="margin-top:12px">Учасники</h3>
    <ul id="hostUsers" class="card" style="min-height:56px;padding:8px"></ul>
    <h3 style="margin-top:12px">Події</h3>
    <div id="hostLog" class="log-box"></div>
  </section>
</div>

<script src="/socket.io/socket.io.js"></script>
<script src="https://cdn.jsdelivr.net/npm/qrcode/build/qrcode.min.js"></script>
<script>
  const $ = (id)=>document.getElementById(id);
  const origin = location.origin.replace(/\\/$/,"");
  const socket = io(origin, { transports:["websocket","polling"] });
  let currentRoom = null;

  // UI helpers
  const log = (m)=>{ const box=$("hostLog"); box.innerHTML += m + "\\n"; box.scrollTop = box.scrollHeight; };
  function playerLink(room){ return origin + "/player?room=" + encodeURIComponent(room||""); }
  function updateShare(){
    const room = $("hostRoom").value.trim() || "class-1";
    const link = playerLink(room);
    $("shareUrl").value = link;
    const qr = $("qrCanvas");
    if (window.QRCode && qr) QRCode.toCanvas(qr, link, { width: 140 });
  }

  $("hostRoom").addEventListener("input", updateShare);
  document.addEventListener("DOMContentLoaded", updateShare);

  $("copyLink").onclick = async ()=>{
    try{
      await navigator.clipboard.writeText($("shareUrl").value);
      log("✓ Лінк скопійовано");
    }catch{
      $("shareUrl").select(); document.execCommand("copy"); log("✓ Лінк скопійовано");
    }
  };

  $("hostJoinBtn").onclick = ()=>{
    currentRoom = $("hostRoom").value.trim() || "class-1";
    socket.emit("host:create", { room: currentRoom });
    updateShare();
    log("✓ Підключено як HOST до " + currentRoom);
  };

  $("btnStart").onclick = ()=>{
    if(!currentRoom) return alert("Спершу створіть/виберіть кімнату");
    const q = $("qText").value.trim();
    const choices = [$("optA").value, $("optB").value, $("optC").value, $("optD").value].filter(x=>x.trim().length);
    const dur = parseInt($("time").value||"20",10);
    if(!q || choices.length<2) return alert("Питання і щонайменше 2 варіанти!");
    socket.emit("host:start", { room: currentRoom, question: q, choices, duration: dur });
    log("▶ Старт питання");
  };

  $("btnReveal").onclick = ()=>{
    if(!currentRoom) return;
    const idx = parseInt($("right").value||"0",10);
    socket.emit("host:reveal", { room: currentRoom, correct: idx });
    log("👁 Reveal: " + idx);
  };

  $("btnNext").onclick = ()=>{
    if(!currentRoom) return;
    socket.emit("host:next", { room: currentRoom });
    $("timer").textContent = "—";
    log("↻ Next round");
  };

  socket.on("host:ready", ({room})=>{ currentRoom=room; updateShare(); });
  socket.on("presence", (list)=>{ $("pcount").textContent = list.length; $("hostUsers").innerHTML = list.map(p=>"<li>"+p.name+"</li>").join(""); });
  socket.on("system", (e)=>log("• " + e.text));
  socket.on("tick", (sec)=>{ $("timer").textContent = sec + "s"; });
  socket.on("timeup", ()=>log("⏰ Час вийшов"));
</script>
`);
});

// Player
app.get("/player", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Player • SparkSchool</title>
<style>${baseCSS}</style>

<div class="wrap grid-2">
  <section class="card">
    <h2>Player</h2>
    <div class="grid" style="grid-template-columns:1fr;gap:10px">
      <input id="room" placeholder="Кімната"/>
      <input id="user" placeholder="Ім’я"/>
      <button class="btn" id="joinBtn">Join</button>
    </div>
    <p class="muted" style="margin-top:8px">Після Join чекайте на питання від вчителя…</p>
    <div id="stage" style="margin-top:12px"></div>
  </section>

  <section class="card">
    <h3>Події</h3>
    <div id="log" class="log-box"></div>
    <h3 style="margin-top:12px">Бали</h3>
    <div id="score" class="card" style="min-height:56px"></div>
  </section>
</div>

<script src="/socket.io/socket.io.js"></script>
<script>
  const $ = (id)=>document.getElementById(id);
  const log = (m)=>{const b=$("log"); b.innerHTML+=m+"\\n"; b.scrollTop=b.scrollHeight;}
  const origin = location.origin.replace(/\\/$/,"");
  const socket = io(origin, { transports:["websocket","polling"] });

  const hashRoom = location.search.match(/room=([^&]+)/) || location.hash.match(/room=([^&]+)/);
  if (hashRoom) $("room").value = decodeURIComponent(hashRoom[1]);

  $("joinBtn").onclick = ()=>{
    const room = $("room").value.trim();
    const name = $("user").value.trim() || "Student";
    if(!room) return alert("Введіть кімнату");
    socket.emit("player:join", { room, name });
    log("✓ Join " + room + " як " + name);
  };

  socket.on("question", ({question,choices,endsIn})=>{
    $("stage").innerHTML = \`
      <div class="card" style="margin-top:8px">
        <div class="muted">Час: <span id="t">\${endsIn}</span> s</div>
        <h3 style="margin:6px 0 10px">\${question}</h3>
        <div class="choices">
          \${choices.map((c,i)=>'<button class="choice" data-i="'+i+'">'+c+'</button>').join('')}
        </div>
      </div>\`;
    document.querySelectorAll('.choice').forEach(btn=>{
      btn.onclick = ()=>{
        const idx = Number(btn.dataset.i);
        socket.emit("player:answer",{ idx });
        btn.classList.add("correct");
      };
    });
  });

  socket.on("tick",(sec)=>{ const t=$("t"); if(t) t.textContent=sec; });
  socket.on("timeup",()=>log("⏰ Час вийшов"));

  socket.on("reveal", ({correct})=>{
    document.querySelectorAll('.choice').forEach((b,i)=>{
      if(i===correct) b.classList.add('correct'); else b.classList.add('wrong');
    });
    log("✅ Правильна: " + correct);
  });

  socket.on("scoreboard",(rows)=>{
    $("score").innerHTML = rows.map(r=>\`<div class="score row"><div>\${r.name}</div><div style="text-align:right">\${r.score}</div></div>\`).join('');
  });

  socket.on("system",(e)=>log("• " + e.text));
  socket.on("answer:ack",()=>log("📨 Відповідь надіслано"));
</script>
`);
});

// Screen (projector)
app.get("/screen", (_req, res) => {
  res.type("html").send(`<!doctype html>
<meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Screen • SparkSchool</title>
<style>${baseCSS}</style>

<div class="wrap">
  <div class="card">
    <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap">
      <h2 id="qq">Очікуємо на питання…</h2>
      <div class="choice" style="font-size:42px" id="tt">—</div>
    </div>
    <div id="choices" class="choices" style="grid-template-columns:1fr 1fr;margin-top:12px"></div>
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
    $("board").innerHTML = rows.map(r=>\`<div class="row"><div>\${r.name}</div><div style="text-align:right">\${r.score}</div></div>\`).join('');
  });
</script>
`);
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/test", (_req, res) => res.redirect("/player"));

/* ================= Start ================= */
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Game server on http://localhost:${PORT}`);
});

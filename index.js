// SparkSchool Game Server — MVP "quiz" версія
// Ролі/екрани: /host (вчитель), /player (учень), /screen (проектор)

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");
const path = require("path");

const app = express();
const server = http.createServer(app);
app.set("trust proxy", true);
app.use(cors());
app.use(express.json());

const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// ====== ІГРОВА МОДЕЛЬ В ПАМ'ЯТІ ===========================================
/*
room = {
  players: Map<socketId,string>,       // хто в кімнаті
  scores: Map<string, number>,         // бали по імені
  state: 'lobby'|'question'|'reveal'|'ended',
  question: string|null,
  choices: string[],                   // варіанти
  correct: number|null,                // індекс правильної
  endsAt: number,                      // дедлайн (ms)
  answers: Map<socketId, {name, idx, at}>, // відповіді раунду
  timer: NodeJS.Timeout|null
}
*/
const rooms = new Map();
function getRoom(code) {
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
}
function presenceList(room) {
  const set = io.sockets.adapter.rooms.get(room);
  if (!set) return [];
  const list = [];
  for (const id of set) {
    const s = io.sockets.sockets.get(id);
    if (s?.data?.name) list.push({ id, name: s.data.name });
  }
  return list;
}
function broadcastScoreboard(roomCode) {
  const R = getRoom(roomCode);
  const rows = [...R.scores.entries()]
    .map(([name, score]) => ({ name, score }))
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  io.to(roomCode).emit("scoreboard", rows);
}
function stopTimer(roomCode) {
  const R = getRoom(roomCode);
  if (R.timer) {
    clearInterval(R.timer);
    R.timer = null;
  }
}

// ====== SOCKET.IO ЛОГІКА ===================================================
io.on("connection", (socket) => {
  // join: {room, name}
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

    // якщо вже йде питання — надішлемо стан новому гравцю
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

  // учнівська відповідь: {idx}
  socket.on("player:answer", ({ idx }) => {
    const room = socket.data?.room;
    const name = socket.data?.name || "Student";
    if (room == null) return;
    const R = getRoom(room);
    if (R.state !== "question") return; // приймаємо тільки під час питання
    if (Date.now() > R.endsAt) return;
    if (R.answers.has(socket.id)) return; // один раз

    const choice = Number(idx);
    R.answers.set(socket.id, { name, idx: choice, at: Date.now() });
    // опційно: підтвердження лише цьому гравцю
    socket.emit("answer:ack", { ok: true, idx: choice });
  });

  // HOST: створити або приєднатись як ведучий
  socket.on("host:create", ({ room }) => {
    if (!room) return;
    socket.join(room);
    socket.data.room = room;
    socket.data.name = "HOST";
    getRoom(room); // ініціюємо
    socket.emit("host:ready", { room });
    io.to(room).emit("presence", presenceList(room));
    broadcastScoreboard(room);
  });

  // HOST: старт раунду
  // payload: {room, question, choices, duration}
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

    // Тікер таймера
    R.timer = setInterval(() => {
      const left = Math.ceil((R.endsAt - Date.now()) / 1000);
      io.to(room).emit("tick", Math.max(0, left));
      if (left <= 0) {
        stopTimer(room);
        io.to(room).emit("timeup");
      }
    }, 1000);
  });

  // HOST: reveal (оголосити правильну)
  // payload: {room, correct}  (індекс)
  socket.on("host:reveal", ({ room, correct }) => {
    if (!room) return;
    const R = getRoom(room);
    stopTimer(room);
    R.state = "reveal";
    R.correct = Number(correct);
    // нарахуємо бали
    for (const { name, idx } of R.answers.values()) {
      if (idx === R.correct) {
        R.scores.set(name, (R.scores.get(name) || 0) + 1);
      }
    }
    io.to(room).emit("reveal", { correct: R.correct });
    broadcastScoreboard(room);
  });

  // HOST: next (очистити стан до лобі, зберігши бали)
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

  // вийти з кімнати
  socket.on("player:leave", () => {
    const room = socket.data?.room;
    const name = socket.data?.name;
    if (!room) return;
    const R = getRoom(room);
    R.players.delete(socket.id);
    socket.leave(room);
    io.to(room).emit("system", { type: "leave", text: `${name} вийшов` });
    io.to(room).emit("presence", presenceList(room));
  });

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

// ====== HTML UI (мінімальний, але «ігровий») ===============================
const baseCSS = `
:root{--bg:#0f1226;--text:#e8eef6;--muted:#9fb3d8;--accent:#ffb300;--card:#171a34;--ok:#22c55e;--err:#ef4444}
*{box-sizing:border-box} body{margin:0;background:radial-gradient(1200px 800px at 80% -10%,#2a2f63 0%,rgba(15,18,38,.6) 60%),var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif}
.wrap{max-width:1000px;margin:32px auto;padding:16px}
.card{background:linear-gradient(180deg,rgba(255,255,255,.05),rgba(255,255,255,.02));border:1px solid rgba(255,255,255,.15);border-radius:16px;padding:18px;box-shadow:0 20px 40px rgba(0,0,0,.35)}
h1,h2,h3{margin:0 0 10px 0} .muted{color:var(--muted)}
.grid{display:grid;gap:16px} @media(min-width:860px){.grid-2{grid-template-columns:1.2fr .8fr}}
label{font-size:.85rem;color:var(--muted)}
input,textarea{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0b1220;color:#fff}
.row{display:grid;gap:12px;grid-template-columns:1fr 1fr 140px}
.btn{padding:.7rem 1rem;border:0;border-radius:12px;background:linear-gradient(135deg,#ffb300,#ff6f00);color:#1b1200;font-weight:800;cursor:pointer}
.btn.sec{background:#0ea5e9;color:#001018}
.badge{display:inline-flex;gap:.5rem;align-items:center;background:rgba(255,255,255,.08);border:1px solid rgba(255,255,255,.15);padding:.35rem .6rem;border-radius:999px;color:var(--muted)}
.log{height:240px;overflow:auto;background:#0b1220;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px;font-family:ui-monospace,Consolas,monospace}
.list li{margin:.25rem 0}
.timer{font-weight:900;font-size:48px;letter-spacing:1px}
.choices{display:grid;gap:10px;margin-top:12px}
.choice{border:1px solid rgba(255,255,255,.14);border-radius:10px;padding:12px;background:#0b1220;cursor:pointer}
.choice.correct{outline:2px solid var(--ok)}
.choice.wrong{opacity:.5}
.score{display:flex;flex-direction:column;gap:6px}
.score .row{grid-template-columns:1fr 60px}
.qr{background:#fff;border-radius:12px;padding:6px}
`;

// Домашня
app.get("/", (_req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>SparkSchool Game</title>
  <style>${baseCSS}</style>
  <div class="wrap grid">
    <section class="card">
      <h1>⚡ SparkSchool • Quiz MVP</h1>
      <p class="muted">Оберіть екран:</p>
      <p>
        <a class="btn" href="/host">Host (вчитель)</a>
        <a class="btn sec" href="/player">Player (учень)</a>
        <a class="btn sec" href="/screen">Screen (проектор)</a>
      </p>
    </section>
    <section class="card">
      <h3>Пояснення</h3>
      <ol>
        <li>Вчитель відкриває <b>/host</b>, створює кімнату (наприклад, <code>class-1</code>).</li>
        <li>Учні відкривають <b>/player</b>, вводять код кімнати/ім’я або сканують QR.</li>
        <li>Host задає питання, варіанти, запускає таймер; після — Reveal.</li>
        <li>Проектор <b>/screen?room=class-1</b> показує питання, таймер і таблицю балів.</li>
      </ol>
    </section>
  </div>`);
});

// Host UI
app.get("/host", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>Host • SparkSchool</title>
  <style>${baseCSS}</style>
  <div class="wrap grid grid-2">
    <section class="card">
      <h1>Host панель</h1>
      <div class="row">
        <div><label>Кімната</label><input id="room" value="class-1"/></div>
        <div><label>&nbsp;</label><button id="create" class="btn">Створити / Підключитись</button></div>
        <div style="display:flex;align-items:end;gap:.5rem">
          <span class="badge">Лінк: <code id="deeplink">—</code></span>
        </div>
      </div>
      <div style="margin-top:8px;display:flex;gap:12px;align-items:center;flex-wrap:wrap">
        <img id="qr" class="qr" width="120" height="120" alt="QR"/>
        <small class="muted">Дайте учням: <b>/player</b> або QR → однакова кімната</small>
      </div>

      <hr style="opacity:.15;margin:16px 0"/>

      <h3>Нове питання</h3>
      <label>Питання</label>
      <textarea id="q" rows="2" placeholder="Наприклад: Як перекладається слово lightning?"></textarea>
      <div class="grid" style="grid-template-columns:1fr 1fr">
        <div><label>Варіант А</label><input id="c0" value="блискавка"/></div>
        <div><label>Варіант B</label><input id="c1" value="гром"/></div>
        <div><label>Варіант C</label><input id="c2" value="дощ"/></div>
        <div><label>Варіант D</label><input id="c3" value="вітер"/></div>
      </div>
      <div class="row" style="margin-top:8px">
        <div><label>Правильна (0-3)</label><input id="correct" value="0"/></div>
        <div><label>Тривалість (сек)</label><input id="dur" value="20"/></div>
        <div style="display:flex;align-items:end;gap:8px">
          <button id="start" class="btn">Start</button>
          <button id="reveal" class="btn sec">Reveal</button>
          <button id="next" class="btn sec">Next</button>
        </div>
      </div>
    </section>

    <aside class="card">
      <h3>Стан</h3>
      <div class="badge">Таймер: <span id="timer">—</span></div>
      <div class="badge">Гравців: <span id="count">0</span></div>
      <h4>Учасники</h4>
      <ul id="people" class="list"></ul>
      <h4>Події</h4>
      <div id="log" class="log"></div>
    </aside>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const $ = (id)=>document.getElementById(id);
    const log = (m)=>{$("log").innerHTML += m+"<br/>"; $("log").scrollTop = $("log").scrollHeight;}
    const origin = location.origin.replace(/\\/$/,"");
    const socket = io(origin, { transports: ["websocket","polling"] });
    let currentRoom = null;

    function updateLinks() {
      const url = origin + "/player#room=" + encodeURIComponent(currentRoom||"");
      $("deeplink").textContent = url;
      $("qr").src = "https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=" + encodeURIComponent(url);
    }

    $("create").onclick = ()=>{
      currentRoom = $("room").value.trim() || "class-1";
      socket.emit("host:create", { room: currentRoom });
      updateLinks();
      log("✓ Підключено як HOST до " + currentRoom);
    };

    $("start").onclick = ()=>{
      if (!currentRoom) return alert("Спершу створіть/виберіть кімнату");
      const q = $("q").value.trim();
      const choices = [$("c0").value, $("c1").value, $("c2").value, $("c3").value].filter(x=>x.trim().length>0);
      const dur = parseInt($("dur").value||"20",10);
      if (!q || choices.length<2) return alert("Питання і щонайменше 2 варіанти!");
      socket.emit("host:start", { room: currentRoom, question: q, choices, duration: dur });
      log("▶ Старт питання");
    };

    $("reveal").onclick = ()=>{
      if (!currentRoom) return;
      const idx = parseInt($("correct").value||"0",10);
      socket.emit("host:reveal", { room: currentRoom, correct: idx });
      log("👁 Reveal: " + idx);
    };

    $("next").onclick = ()=>{
      if (!currentRoom) return;
      socket.emit("host:next", { room: currentRoom });
      $("timer").textContent = "—";
      log("↻ Next round");
    };

    socket.on("host:ready", ({room})=>{ currentRoom = room; updateLinks(); });
    socket.on("presence", (list)=>{ $("count").textContent = list.length; $("people").innerHTML = list.map(p=>"<li>"+p.name+"</li>").join(""); });
    socket.on("system", (e)=>log("• " + e.text));
    socket.on("tick", (sec)=>{ $("timer").textContent = sec + "s"; });
    socket.on("timeup", ()=>log("⏰ Час вийшов"));
  </script>
  `);
});

// Player UI
app.get("/player", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>Player • SparkSchool</title>
  <style>${baseCSS}</style>
  <div class="wrap grid grid-2">
    <section class="card">
      <h1>Player</h1>
      <div class="row">
        <div><label>Кімната</label><input id="room" value="class-1"/></div>
        <div><label>Ім'я</label><input id="name" value="Student"/></div>
        <div style="display:flex;align-items:end"><button id="join" class="btn">Join</button></div>
      </div>
      <div id="stage" style="margin-top:12px">
        <p class="muted">Після Join чекайте на питання від вчителя…</p>
      </div>
    </section>

    <aside class="card">
      <h3>Події</h3>
      <div id="log" class="log"></div>
      <h3>Бали</h3>
      <div id="score" class="score"></div>
    </aside>
  </div>

  <script src="/socket.io/socket.io.js"></script>
  <script>
    const $ = (id)=>document.getElementById(id);
    const log = (m)=>{$("log").innerHTML += m+"<br/>"; $("log").scrollTop=$("log").scrollHeight;}
    const origin = location.origin.replace(/\\/$/,"");
    const socket = io(origin, { transports:["websocket","polling"] });

    // room з хеша
    const m = location.hash.match(/room=([^&]+)/);
    if (m) $("room").value = decodeURIComponent(m[1]);

    $("join").onclick = ()=>{
      const room = $("room").value.trim();
      const name = $("name").value.trim() || "Student";
      if (!room) return alert("Введіть кімнату");
      socket.emit("player:join", { room, name });
      log("✓ Join " + room + " як " + name);
    };

    socket.on("question", ({question, choices, endsIn})=>{
      $("stage").innerHTML = \`
        <div class="badge">Час: <span id="t">\${endsIn}</span> s</div>
        <h2>\${question}</h2>
        <div class="choices">
          \${choices.map((c,i)=>'<button class="choice" data-i="'+i+'">'+c+'</button>').join('')}
        </div>
      \`;
      document.querySelectorAll('.choice').forEach(btn=>{
        btn.onclick = ()=>{
          const idx = Number(btn.dataset.i);
          socket.emit("player:answer", { idx });
          btn.classList.add("choice","correct"); // візуальний фідбек
        };
      });
    });

    socket.on("tick",(sec)=>{ const t=$("t"); if(t) t.textContent=sec; });
    socket.on("timeup",()=>{ log("⏰ Час вийшов"); });

    socket.on("reveal", ({correct})=>{
      const btns = document.querySelectorAll('.choice');
      btns.forEach((b,i)=>{
        if (i===correct) b.classList.add('correct'); else b.classList.add('wrong');
      });
      log("✅ Правильна: " + correct);
    });

    socket.on("scoreboard", (rows)=>{
      $("score").innerHTML = rows.map(r=>\`
        <div class="row"><div>\${r.name}</div><div style="text-align:right">\${r.score}</div></div>
      \`).join('');
    });

    socket.on("system",(e)=>log("• " + e.text));
    socket.on("answer:ack",()=>log("📨 Відповідь надіслано"));
  </script>
  `);
});

// Screen (projector) UI
app.get("/screen", (req, res) => {
  res.type("html").send(`<!doctype html><meta charset="utf-8"/>
  <title>Screen • SparkSchool</title>
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

    // room з query (?room=class-1) або з hash (#room=)
    const params = new URLSearchParams(location.search);
    let room = params.get("room");
    if (!room) {
      const m = location.hash.match(/room=([^&]+)/);
      if (m) room = decodeURIComponent(m[1]);
    }
    if (!room) room = "class-1";
    // приєднаємось як "глядач" (просто join для presence/scoreboard)
    socket.emit("player:join", { room, name: "Screen" });

    socket.on("question", ({question, choices})=>{
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
  </script>
  `);
});

// Health & тест
app.get("/healthz", (_req, res) => res.json({ ok: true, ts: Date.now() }));
app.get("/test", (_req, res) => res.redirect("/player")); // старий /test → на player

// START
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Game server on http://localhost:${PORT}`);
});

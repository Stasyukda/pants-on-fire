// index.js
// Spark Game Server — дружелюбна версія 🙂

const express = require("express");
const http = require("http");
const cors = require("cors");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);

// Якщо запускаємо за проксі (Fly.io / інші), вмикаємо довіру до заголовків
app.set("trust proxy", true);

app.use(cors());
app.use(express.json());

// ************ Socket.IO ************
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

// Допоміжна мапа для зручного presence
// socket.data = { name, room }
function buildPresence(room) {
  const set = io.sockets.adapter.rooms.get(room); // Set of socket IDs
  if (!set) return [];
  const list = [];
  for (const id of set) {
    const s = io.sockets.sockets.get(id);
    if (s?.data) {
      list.push({ id, name: s.data.name || "Anon" });
    }
  }
  return list;
}

io.on("connection", (socket) => {
  console.log("🔌 Client connected", socket.id);

  socket.on("join", ({ room, name }) => {
    if (!room) return;
    socket.join(room);
    socket.data = socket.data || {};
    socket.data.room = room;
    socket.data.name = (name || "Student").toString().slice(0, 40);

    // Сист. сповіщення в кімнаті
    io.to(room).emit("system", {
      type: "join",
      text: `${socket.data.name} приєднався`,
      at: Date.now(),
    });

    // Оновити presence
    io.to(room).emit("presence", buildPresence(room));
    console.log(`👥 ${socket.data.name} joined ${room}`);
  });

  socket.on("answer", (payload) => {
    const room = socket.data?.room;
    if (!room) return;

    const msg = {
      user: socket.data?.name || "Student",
      value: String(payload?.value ?? ""),
      at: Date.now(),
    };

    // Транслюємо в межах кімнати
    io.to(room).emit("answer", msg);
  });

  socket.on("leave", () => {
    const room = socket.data?.room;
    if (room) {
      socket.leave(room);
      io.to(room).emit("system", {
        type: "leave",
        text: `${socket.data?.name || "Student"} вийшов`,
        at: Date.now(),
      });
      io.to(room).emit("presence", buildPresence(room));
      socket.data.room = null;
    }
  });

  socket.on("disconnect", () => {
    const room = socket.data?.room;
    if (room) {
      io.to(room).emit("system", {
        type: "leave",
        text: `${socket.data?.name || "Student"} відключився`,
        at: Date.now(),
      });
      io.to(room).emit("presence", buildPresence(room));
    }
    console.log("❌ Client disconnected", socket.id);
  });
});

// ************ HTTP маршрути ************
app.get("/", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="uk">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Spark Game Server ✔</title>
      <style>
        body{font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif;margin:2rem;line-height:1.5}
        a.btn{display:inline-block;padding:.6rem 1rem;border-radius:.6rem;background:#0ea5e9;color:#fff;text-decoration:none}
        .muted{color:#666}
        .box{margin-top:1rem;padding:1rem;border:1px solid #eee;border-radius:.6rem;background:#fafafa}
      </style>
    </head>
    <body>
      <h1>Spark Game Server ✔</h1>
      <p class="muted">Готово до роботи. Відкрий <code>/test</code> для демо-клієнта.</p>
      <div class="box">
        <a class="btn" href="/test">Відкрити демо</a>
      </div>
    </body>
    </html>
  `);
});

// Красивіший демо-клієнт
app.get("/test", (req, res) => {
  res.type("html").send(`
    <!doctype html>
    <html lang="uk">
    <head>
      <meta charset="utf-8"/>
      <meta name="viewport" content="width=device-width,initial-scale=1"/>
      <title>Spark Game • Demo</title>
      <style>
        :root{
          --bg:#0f172a; --card:#111827; --text:#e5e7eb; --muted:#9ca3af; --accent:#f59e0b; --ok:#22c55e;
        }
        *{box-sizing:border-box}
        body{margin:0;background:radial-gradient(1200px 800px at 80% -10%,#1d2a6a 0%,rgba(15,18,38,.6) 60%),var(--bg);color:var(--text);font-family:system-ui,Segoe UI,Roboto,Arial,sans-serif}
        .wrap{max-width:980px;margin:40px auto;padding:24px}
        .grid{display:grid;gap:16px;grid-template-columns:1fr; }
        @media(min-width:860px){ .grid{grid-template-columns:1.2fr .8fr} }
        .card{background:linear-gradient(180deg,rgba(255,255,255,.04),rgba(255,255,255,.02)); border:1px solid rgba(255,255,255,.12); border-radius:16px; padding:20px; box-shadow:0 20px 40px rgba(0,0,0,.3)}
        h1{margin:0 0 8px 0;font-size:clamp(28px,6vw,36px);line-height:1.05}
        .muted{color:var(--muted);margin:.25rem 0 .75rem}
        label{font-size:.85rem;color:var(--muted)}
        input{width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14); background:#0b1220; color:#fff}
        .row{display:grid;gap:12px;grid-template-columns:1fr 1fr 100px}
        button{padding:.7rem 1rem;border:0;border-radius:12px;background:linear-gradient(135deg,#f59e0b,#f97316);color:#1b1b1f;font-weight:700;cursor:pointer}
        button.secondary{background:#0ea5e9;color:#001018}
        .log{height:360px;overflow:auto;background:#0b1220;border:1px solid rgba(255,255,255,.12);border-radius:12px;padding:10px;font-family:ui-monospace,Consolas,monospace}
        .ok{color:var(--ok)}
        .pill{display:inline-flex;align-items:center;gap:.4rem;font-size:.8rem;background:#0b1220;border:1px solid rgba(255,255,255,.12);padding:.35rem .6rem;border-radius:999px}
        .copy{margin-left:.5rem}
        small{color:var(--muted)}
        .list li{margin:.2rem 0}
        img.qr{background:#fff;border-radius:12px;padding:6px}
      </style>
    </head>
    <body>
      <div class="wrap">
        <div class="grid">
          <section class="card">
            <h1>Скоро відкриття та новий набір <span style="color:var(--accent)">2025–2026</span></h1>
            <p class="muted">Демо підключення. Обери кімнату й ім’я, натисни “Зайти”. Відкрий цю ж сторінку на іншому пристрої і відскануй QR.</p>
            <div class="row">
              <div><label>Кімната</label><input id="room" value="class-1"/></div>
              <div><label>Ім’я</label><input id="name" value="Student"/></div>
              <div style="display:flex;align-items:flex-end"><button id="joinBtn">Зайти</button></div>
            </div>

            <div style="margin-top:14px;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap">
              <span class="pill">Посилання кімнати: <code id="roomLink">—</code></span>
              <button class="secondary copy" id="copyBtn" title="Скопіювати">Скопіювати</button>
            </div>

            <div style="margin-top:14px;display:flex;align-items:center;gap:1rem;flex-wrap:wrap">
              <div>
                <label>Відповідь</label>
                <div style="display:flex;gap:.5rem;align-items:center">
                  <input id="answer" value="Hi" style="max-width:240px"/>
                  <button id="sendBtn">Надіслати</button>
                </div>
              </div>
              <div>
                <label>QR для підключення</label><br/>
                <img id="qr" class="qr" width="120" height="120" alt="QR"/>
              </div>
            </div>
          </section>

          <aside class="card">
            <h3 style="margin-top:0">Учасники кімнати</h3>
            <ul class="list" id="people"></ul>
            <small class="muted">Список оновлюється автоматично.</small>
          </aside>
        </div>

        <section class="card" style="margin-top:16px">
          <h3 style="margin:0 0 8px 0">Події</h3>
          <div id="log" class="log"></div>
        </section>
      </div>

      <script src="/socket.io/socket.io.js"></script>
      <script>
        const $ = (id) => document.getElementById(id);
        const log = (html) => { const el = document.createElement('div'); el.innerHTML = html; $('log').appendChild(el); $('log').scrollTop = $('log').scrollHeight; };

        const origin = window.location.origin.replace(/\\/$/, "");
        const socket = io(origin, { transports:['websocket','polling'] });

        function updateDeepLink(room) {
          const url = origin + '/test#room=' + encodeURIComponent(room);
          $('roomLink').textContent = url;
          $('qr').src = 'https://api.qrserver.com/v1/create-qr-code/?size=160x160&data=' + encodeURIComponent(url);
          return url;
        }

        function renderPeople(list) {
          const ul = $('people');
          ul.innerHTML = '';
          list.forEach(p => {
            const li = document.createElement('li');
            li.textContent = p.name;
            ul.appendChild(li);
          });
        }

        $('joinBtn').onclick = () => {
          const room = $('room').value.trim() || 'class-1';
          const name = $('name').value.trim() || 'Student';
          socket.emit('join', { room, name });
          updateDeepLink(room);
          log('<span class="ok">✓ Зайшли в кімнату:</span> ' + room);
        };

        $('copyBtn').onclick = async () => {
          try {
            const url = $('roomLink').textContent;
            await navigator.clipboard.writeText(url);
            log('<span class="ok">✓ Посилання скопійовано</span>');
          } catch(e) { log('Не вдалося скопіювати'); }
        };

        $('sendBtn').onclick = () => {
          const value = $('answer').value;
          socket.emit('answer', { value });
        };

        // Якщо в хеші є room — підставимо
        (function hydrateFromHash(){
          const m = location.hash.match(/room=([^&]+)/);
          if (m) { $('room').value = decodeURIComponent(m[1]); updateDeepLink($('room').value); }
          else { updateDeepLink($('room').value); }
        })();

        socket.on('connect', () => log('<span class="ok">✓ Підключено</span>'));
        socket.on('disconnect', () => log('• Відключено'));

        socket.on('system', (e) => log('• ' + e.text));
        socket.on('answer', (msg) => {
          log('🗨️ <b>'+ (msg.user||'Student') + ':</b> ' + msg.value + ' <small class="muted">(' + new Date(msg.at).toLocaleTimeString() + ')</small>');
        });
        socket.on('presence', renderPeople);
      </script>
    </body>
    </html>
  `);
});

// healthcheck для Fly.io / моніторингу
app.get("/healthz", (req, res) => res.json({ ok: true, ts: Date.now() }));

// ************ START ************
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Server started on http://localhost:${PORT}`);
});

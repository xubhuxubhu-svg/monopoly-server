// ============================================================
// 萌樂大富翁 - 多人連線伺服器
// 功能：房間建立/加入、玩家列表即時同步、斷線/重連處理
// 之後的棋盤同步、建造同步、小遊戲對戰邏輯，都會建立在這個地基上
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // 開發階段先全開放，正式上線可收緊成指定網域
});

const PORT = process.env.PORT || 3000;

// 提供靜態測試前端（/public 資料夾），方便直接用瀏覽器測試整套連線流程
app.use(express.static(path.join(__dirname, 'public')));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

// ---------------- 房間資料結構 ----------------
// rooms: Map<roomCode, { players: Map<socketId, playerInfo>, hostId, createdAt, started }>
const rooms = new Map();

const MAX_PLAYERS_PER_ROOM = 4;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混淆字元 (I,O,0,1)

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () => ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]).join('');
  } while (rooms.has(code));
  return code;
}

function getPublicRoomState(room) {
  return {
    players: Array.from(room.players.values()),
    hostId: room.hostId,
    started: room.started,
  };
}

function broadcastRoomState(roomCode) {
  const room = rooms.get(roomCode);
  if (!room) return;
  io.to(roomCode).emit('room_state', getPublicRoomState(room));
}

io.on('connection', (socket) => {
  console.log(`[連線] ${socket.id}`);

  // ---- 建立房間 ----
  socket.on('create_room', ({ playerName }, callback) => {
    const roomCode = generateRoomCode();
    const room = {
      players: new Map(),
      hostId: socket.id,
      createdAt: Date.now(),
      started: false,
    };
    room.players.set(socket.id, {
      id: socket.id,
      name: (playerName || '玩家').slice(0, 12),
      isHost: true,
      ready: false,
      characterId: null,
    });
    rooms.set(roomCode, room);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    console.log(`[建房] ${roomCode} by ${socket.id}`);
    callback({ ok: true, roomCode, state: getPublicRoomState(room) });
  });

  // ---- 加入房間 ----
  socket.on('join_room', ({ roomCode, playerName }, callback) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(roomCode);

    if (!room) {
      return callback({ ok: false, error: '找不到這個房間代碼，請確認代碼是否正確' });
    }
    if (room.started) {
      return callback({ ok: false, error: '這場遊戲已經開始了，無法加入' });
    }
    if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
      return callback({ ok: false, error: '房間已滿（最多4人）' });
    }

    room.players.set(socket.id, {
      id: socket.id,
      name: (playerName || '玩家').slice(0, 12),
      isHost: false,
      ready: false,
      characterId: null,
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;

    console.log(`[加入] ${roomCode} <- ${socket.id}`);
    callback({ ok: true, roomCode, state: getPublicRoomState(room) });
    broadcastRoomState(roomCode);
  });

  // ---- 玩家準備狀態切換 ----
  socket.on('toggle_ready', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    const player = room.players.get(socket.id);
    if (!player) return;
    player.ready = !player.ready;
    broadcastRoomState(roomCode);
  });

  // ---- 房主開始遊戲（之後可加：需全員ready才能開始）----
  socket.on('start_game', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return;
    if (room.hostId !== socket.id) return; // 只有房主能開始
    room.started = true;
    io.to(roomCode).emit('game_started');
    broadcastRoomState(roomCode);
    console.log(`[開始遊戲] ${roomCode}`);
  });

  // ---- 簡易測試訊息廣播（驗證即時同步用，之後會換成真正的遊戲事件） ----
  socket.on('test_ping', (msg) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    io.to(roomCode).emit('test_pong', { from: socket.id, msg, at: Date.now() });
  });

  // ---- 離線處理 ----
  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    console.log(`[斷線] ${socket.id} (room: ${roomCode || '無'})`);
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(roomCode);
      console.log(`[房間清空刪除] ${roomCode}`);
      return;
    }

    // 房主離線 → 轉移給下一位還在房間裡的玩家
    if (room.hostId === socket.id) {
      const nextHost = room.players.keys().next().value;
      room.hostId = nextHost;
      room.players.get(nextHost).isHost = true;
      console.log(`[房主轉移] ${roomCode} -> ${nextHost}`);
    }

    broadcastRoomState(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`伺服器啟動，監聽 port ${PORT}`);
});

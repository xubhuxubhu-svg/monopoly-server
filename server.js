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

  // ============================================================
  // 大富翁棋盤核心連線同步（第一階段：擲骰/回合順序/落地結果 relay）
  // 架構：當下輪到誰，就由那位玩家的瀏覽器端完整跑一次原本單機邏輯
  // （移動、買地、小遊戲結果、建造觸發…都在他自己的畫面互動決定），
  // 伺服器只負責：① 骰子點數由伺服器亂數決定並回覆給發起請求的人，
  // ② 該玩家跑完整個回合後把最終狀態快照轉發給房間內其他人套用，
  // ③ 記錄目前輪到哪個座位，讓所有人畫面上的「誰可以擲骰」一致。
  // ============================================================

  // 房主開始「大富翁對局」：把目前房間玩家依加入順序鎖定座位順序
  socket.on('start_monopoly_game', ({ rule }, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ ok:false, error:'找不到房間' });
    if (room.hostId !== socket.id) return callback && callback({ ok:false, error:'只有房主能開始' });
    if (room.players.size < 2) return callback && callback({ ok:false, error:'至少需要2位玩家才能開始' });

    const seatOrder = Array.from(room.players.values()).map((p, i) => ({ id: p.id, name: p.name, seatIndex: i }));
    room.mp = {
      seatOrder,
      currentTurnSeatIdx: 0,
      rule: rule === 'turns' ? 'turns' : 'bankruptcy',
    };
    room.started = true;

    io.to(roomCode).emit('mp_game_start', { seatOrder, rule: room.mp.rule, startSeatIdx: 0 });
    console.log(`[大富翁開局] ${roomCode} 座位:`, seatOrder.map(s=>s.name).join(', '));
    callback && callback({ ok:true });
  });

  // 目前輪到的玩家請求伺服器擲骰（伺服器亂數，避免各自算出不同點數）
  socket.on('request_roll', (data, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return callback && callback({ ok:false, error:'尚未開局' });
    const seat = room.mp.seatOrder[room.mp.currentTurnSeatIdx];
    if (!seat || seat.id !== socket.id) return callback && callback({ ok:false, error:'還沒輪到你' });
    const value = 1 + Math.floor(Math.random() * 6);
    callback && callback({ ok:true, value });
  });

  // 即時事件轉發（不用等回合結束）：目前用在「開始施工」「施工加速」，一收到就馬上轉給房間其他人
  socket.on('instant_action', (action) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return;
    socket.to(roomCode).emit('instant_action', action);
  });

  // 目前輪到的玩家跑完整個回合後，把最終狀態快照 + 下一位座位廣播給房間其他人
  socket.on('state_sync', ({ snapshot, nextSeatIdx }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return;
    const seat = room.mp.seatOrder[room.mp.currentTurnSeatIdx];
    if (!seat || seat.id !== socket.id) return; // 只信任目前輪到的玩家送出的快照
    if (typeof nextSeatIdx === 'number' && nextSeatIdx >= 0 && nextSeatIdx < room.mp.seatOrder.length) {
      room.mp.currentTurnSeatIdx = nextSeatIdx;
    }
    socket.to(roomCode).emit('state_sync', { snapshot, currentTurnSeatIdx: room.mp.currentTurnSeatIdx });
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

    if (room.mp) {
      io.to(roomCode).emit('mp_player_left', {});
    }

    broadcastRoomState(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`伺服器啟動，監聽 port ${PORT}`);
});

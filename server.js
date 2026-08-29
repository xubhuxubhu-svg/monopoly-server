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

// 玩家身份卡：從第一次連線就跟著玩家，之後不管開幾個內嵌小遊戲視窗(等於好幾條連線)，
// 伺服器都能靠這組固定代碼認出「這是同一個人」，不會被每次連線都不同的socket.id搞混
function generateToken() {
  return 'p_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

function getPublicRoomState(room) {
  return {
    players: Array.from(room.players.values()).map(p => ({ id:p.id, name:p.name, isHost:p.isHost, ready:p.ready, characterId:p.characterId })),
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
  socket.on('create_room', ({ playerName, playerToken }, callback) => {
    const roomCode = generateRoomCode();
    const token = playerToken || generateToken();
    const room = {
      players: new Map(),
      hostId: socket.id,
      hostToken: token,
      createdAt: Date.now(),
      started: false,
    };
    room.players.set(socket.id, {
      id: socket.id,
      token,
      name: (playerName || '玩家').slice(0, 12),
      isHost: true,
      ready: false,
      characterId: null,
    });
    rooms.set(roomCode, room);

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = token;

    console.log(`[建房] ${roomCode} by ${socket.id}`);
    callback({ ok: true, roomCode, playerToken: token, state: getPublicRoomState(room) });
  });

  // ---- 加入房間 ----
  socket.on('join_room', ({ roomCode, playerName, playerToken }, callback) => {
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

    const token = playerToken || generateToken();
    room.players.set(socket.id, {
      id: socket.id,
      token,
      name: (playerName || '玩家').slice(0, 12),
      isHost: false,
      ready: false,
      characterId: null,
    });

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = token;

    console.log(`[加入] ${roomCode} <- ${socket.id}`);
    callback({ ok: true, roomCode, playerToken: token, state: getPublicRoomState(room) });
    broadcastRoomState(roomCode);
  });

  // ---- 內嵌小遊戲視窗用：用同一個玩家身份卡(token)加入伺服器對這個房間的廣播頻道，
  //      不重新跑一次大廳/房主邏輯，純粹只是「這條新連線也算同一個人」----
  socket.on('join_as_participant', ({ roomCode, playerToken }, callback) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ ok:false, error:'房間不存在' });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;
    callback && callback({ ok:true });

    // 這條連線通常是稍晚才建立的內嵌小遊戲視窗(iframe載入需要時間)，
    // 如果小遊戲的「開始」廣播已經先發生過了，直接把目前最新狀態補發給它，
    // 不要讓它苦等一個早就已經過去的廣播
    if (room.pw) {
      socket.emit('password_game_start', { seatOrder: room.pw.seatOrder, rangeMax: room.pw.rangeMax, startSeatIdx: room.pw.currentTurnSeatIdx });
    }
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

    const seatOrder = Array.from(room.players.values()).map((p, i) => ({ id: p.id, token: p.token, name: p.name, seatIndex: i }));
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
    if (!seat || seat.token !== socket.data.playerToken) return callback && callback({ ok:false, error:'還沒輪到你' });
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
    if (!seat || seat.token !== socket.data.playerToken) return; // 只信任目前輪到的玩家送出的快照
    if (typeof nextSeatIdx === 'number' && nextSeatIdx >= 0 && nextSeatIdx < room.mp.seatOrder.length) {
      room.mp.currentTurnSeatIdx = nextSeatIdx;
    }
    socket.to(roomCode).emit('state_sync', { snapshot, currentTurnSeatIdx: room.mp.currentTurnSeatIdx });
  });

  // ============================================================
  // 小遊戲觸發機制（棋盤買地/被踩地/蓋房時，隨機抽一款小遊戲，強制全員參加）
  // 觸發的當下由伺服器隨機決定玩哪一款、直接用棋盤那一局既有的座位順序(room.mp.seatOrder)，
  // 不需要另外開一次「大廳」；小遊戲結束時，由伺服器判定「觸發的那個人是不是贏家」。
  // ============================================================

  // 目前已經接好連線的小遊戲：之後每完成一款新的，往這個陣列加一個名字即可
  const AVAILABLE_MINIGAMES = ['ultimate_password'];

  function startMinigameInternal(roomCode, gameId){
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return;
    const seatOrder = room.mp.seatOrder;

    if (gameId === 'ultimate_password') {
      const rangeMax = 100;
      const target = 1 + Math.floor(Math.random() * rangeMax);
      room.pw = { seatOrder, currentTurnSeatIdx: 0, low: 1, high: rangeMax, rangeMax, target };
      io.to(roomCode).emit('password_game_start', { seatOrder, rangeMax, startSeatIdx: 0 });
    }
    // 之後其他小遊戲(123木頭人/麻將/飛機射擊/鬼抓人)接好後，在這裡加對應的 else if 分支
  }

  socket.on('trigger_minigame', ({ reason, tileIndex }, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return callback && callback({ ok:false, error:'尚未開局' });
    const triggerSeat = room.mp.seatOrder.find(s => s.token === socket.data.playerToken);
    if (!triggerSeat) return callback && callback({ ok:false, error:'找不到你的座位' });

    const gameId = AVAILABLE_MINIGAMES[Math.floor(Math.random() * AVAILABLE_MINIGAMES.length)];
    room.activeMinigame = {
      gameId, reason, tileIndex,
      triggerToken: triggerSeat.token, triggerName: triggerSeat.name,
      resultReported: false,
    };

    io.to(roomCode).emit('minigame_triggered', {
      gameId, reason, tileIndex,
      triggerToken: triggerSeat.token, triggerName: triggerSeat.name,
    });
    startMinigameInternal(roomCode, gameId);
    console.log(`[小遊戲觸發] ${roomCode} 原因:${reason} 觸發者:${triggerSeat.name} 抽到:${gameId}`);
    callback && callback({ ok:true, gameId });
  });

  // 小遊戲結束，任何一個客戶端(通常是判定出贏家的那個)回報結果，伺服器轉發給全房間，
  // 並附上「觸發者是否獲勝」讓棋盤知道要套用成功還是失敗的邏輯
  socket.on('minigame_finished', ({ winnerToken, winnerName }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.activeMinigame || room.activeMinigame.resultReported) return;
    room.activeMinigame.resultReported = true;
    const success = winnerToken === room.activeMinigame.triggerToken;
    io.to(roomCode).emit('minigame_result', {
      winnerToken, winnerName, success,
      reason: room.activeMinigame.reason, tileIndex: room.activeMinigame.tileIndex,
    });
    console.log(`[小遊戲結束] ${roomCode} 贏家:${winnerName} 觸發者成功嗎:${success}`);
    room.pw = null;
    room.activeMinigame = null;
  });

  // ============================================================
  // 終極密碼小遊戲 連線同步：密碼由伺服器保管，玩家永遠看不到答案，
  // 送出猜測由伺服器判定後廣播結果。房間座位沿用棋盤的 room.mp.seatOrder，
  // 由 trigger_minigame 觸發開局，不需要另外的大廳流程。
  // ============================================================

  socket.on('password_submit_guess', ({ guess }, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.pw) return callback && callback({ ok:false, error:'尚未開局' });
    const pw = room.pw;
    const seat = pw.seatOrder[pw.currentTurnSeatIdx];
    if (!seat || seat.token !== socket.data.playerToken) return callback && callback({ ok:false, error:'還沒輪到你' });
    if (typeof guess !== 'number' || guess < pw.low || guess > pw.high) {
      return callback && callback({ ok:false, error:'猜測超出目前範圍' });
    }

    let hint, bingo = false;
    if (guess === pw.target) { hint = 'bingo'; bingo = true; }
    else if (guess < pw.target) { hint = 'low'; pw.low = guess + 1; }
    else { hint = 'high'; pw.high = guess - 1; }

    const guesserName = seat.name;
    const guesserToken = seat.token;
    let nextSeatIdx = pw.currentTurnSeatIdx;
    if (!bingo) {
      nextSeatIdx = (pw.currentTurnSeatIdx + 1) % pw.seatOrder.length;
      pw.currentTurnSeatIdx = nextSeatIdx;
    }

    io.to(roomCode).emit('password_guess_result', {
      guesserToken, guesserName, guess, hint, bingo,
      low: pw.low, high: pw.high, nextSeatIdx,
      target: bingo ? pw.target : undefined,
    });
    console.log(`[終極密碼] ${roomCode} ${guesserName} 猜 ${guess} -> ${hint}`);
    callback && callback({ ok:true });

    if (bingo) {
      // 賓果的人就是這場小遊戲的贏家，直接觸發統一的小遊戲結束流程
      const fakeRoom = rooms.get(roomCode);
      if (fakeRoom && fakeRoom.activeMinigame && !fakeRoom.activeMinigame.resultReported) {
        fakeRoom.activeMinigame.resultReported = true;
        const success = guesserToken === fakeRoom.activeMinigame.triggerToken;
        io.to(roomCode).emit('minigame_result', {
          winnerToken: guesserToken, winnerName: guesserName, success,
          reason: fakeRoom.activeMinigame.reason, tileIndex: fakeRoom.activeMinigame.tileIndex,
        });
        fakeRoom.pw = null;
        fakeRoom.activeMinigame = null;
      }
    }
  });

  // ============================================================
  // 123木頭人／麻將／飛機射擊／鬼抓人：尚未套用「觸發式強制參加」機制，
  // 之後每完成一款，會在這裡加上跟終極密碼同樣模式的連線同步程式碼，
  // 並把遊戲代號加進上面的 AVAILABLE_MINIGAMES 陣列。
  // ============================================================

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
    if (room.pw) {
      io.to(roomCode).emit('pw_player_left', {});
    }

    broadcastRoomState(roomCode);
  });
});

server.listen(PORT, () => {
  console.log(`伺服器啟動，監聽 port ${PORT}`);
});

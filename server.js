// ============================================================
// 萌樂大富翁 - 多人連線伺服器
// 功能：房間建立/加入、玩家列表即時同步、斷線/重連處理
// 之後的棋盤同步、建造同步、小遊戲對戰邏輯，都會建立在這個地基上
// ============================================================

const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const { MongoClient } = require('mongodb');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // 開發階段先全開放，正式上線可收緊成指定網域
});

const PORT = process.env.PORT || 3000;

// ---------------- 存檔/排行榜資料庫（MongoDB Atlas 免費方案）----------------
// 沒有設定 MONGODB_URI 環境變數的話，存檔/排行榜這兩個功能會自動關閉，
// 不影響其他所有功能正常運作（房間、棋盤、小遊戲、攻城戰都跟資料庫無關）。
let db = null;
let dbReady = false;
if (process.env.MONGODB_URI) {
  const mongoClient = new MongoClient(process.env.MONGODB_URI);
  mongoClient.connect()
    .then(() => {
      db = mongoClient.db('monopoly');
      dbReady = true;
      console.log('[資料庫] MongoDB 連線成功，存檔/排行榜功能已啟用');
    })
    .catch(err => {
      console.error('[資料庫] MongoDB 連線失敗，存檔/排行榜功能停用：', err.message);
    });
} else {
  console.log('[資料庫] 沒有設定 MONGODB_URI，存檔/排行榜功能停用（其他功能不受影響）');
}

// 提供靜態測試前端與小遊戲檔案（跟 server.js 同一層目錄，不需要另外的 public 資料夾）
app.use(express.static(__dirname));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size, db: dbReady }));

// ---------------- 房間資料結構 ----------------
// rooms: Map<roomCode, { players: Map<socketId, playerInfo>, hostId, createdAt, started }>
const rooms = new Map();

const MAX_PLAYERS_PER_ROOM = 4;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 排除易混淆字元 (I,O,0,1)
const RECONNECT_GRACE_MS = 10 * 60 * 1000; // 遊戲進行中斷線，保留座位10分鐘，讓玩家有機會重新整理頁面回來

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
    players: Array.from(room.players.values()).map(p => ({ id:p.id, name:p.name, isHost:p.isHost, ready:p.ready, characterId:p.characterId, disconnected:!!p.disconnected })),
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
    if (room.rl) {
      socket.emit('redlight_game_start', { seatOrder: room.rl.seatOrder, trackLen: room.rl.trackLen, progress: room.rl.progress, caughtTokens: Array.from(room.rl.caughtTokens||[]) });
      socket.emit('redlight_phase', { phase: room.rl.phase, phaseEndsAt: room.rl.phaseEndsAt });
    }
    if (room.gt) {
      socket.emit('ghost_tag_game_start', {
        seatOrder: room.gt.seatOrder, obstacles: room.gt.obstacles,
        itIndex: room.gt.itIndex, matchStartAt: room.gt.matchStartAt,
        triggerToken: room.gt.triggerToken,
      });
    }
    if (room.ps) {
      socket.emit('plane_shooter_game_start', {
        seatOrder: room.ps.seatOrder, matchStartAt: room.ps.matchStartAt, triggerToken: room.ps.triggerToken,
      });
    }
    if (room.mj && room.mj.hands[playerToken]) {
      socket.emit('mahjong_game_start', {
        seatOrder: room.mj.seatOrder.map(x => ({ token:x.token, name:x.name })),
        yourHand: room.mj.hands[playerToken],
        wallCount: room.mj.wall.length,
        currentIndex: room.mj.currentIndex,
      });
      socket.emit('mahjong_public_update', {
        wallCount: room.mj.wall.length, currentIndex: room.mj.currentIndex,
        handCounts: mjHandCounts(room),
      });
      if (room.mj.pendingToken === playerToken) {
        if (room.mj.pendingType === 'selfwin') socket.emit('mahjong_offer_self_win', {});
        else if (room.mj.pendingType === 'discard') socket.emit('mahjong_await_discard', {});
        else if (room.mj.pendingType === 'hu') socket.emit('mahjong_offer_hu', { tile: room.mj.lastDiscard.tile, fromName: room.mj.lastDiscard.fromName });
      }
    }
    if (room.bj && room.bj.hands[playerToken]) {
      socket.emit('blackjack_round_start', {
        seatOrder: room.bj.seatOrder.map(x => ({ token:x.token, name:x.name, wins: room.bj.wins[x.token] })),
        yourHand: room.bj.hands[playerToken],
        round: room.bj.currentRound, totalRounds: BJ_TOTAL_ROUNDS,
      });
      socket.emit('blackjack_public_update', {
        currentIndex: room.bj.currentIndex, statuses: bjStatuses(room),
      });
      if (room.bj.pendingToken === playerToken) {
        socket.emit('blackjack_your_turn', {});
      }
    }
    if (room.siege) {
      if (room.siege.phase === 'tankpick') {
        socket.emit('siege_lobby_start', { seatOrder: room.siege.seatOrder });
        socket.emit('siege_picks_update', { tankPicks: room.siege.tankPicks });
        socket.emit('siege_ready_update', { readyTokens: Array.from(room.siege.readySet) });
      } else if (room.siege.phase === 'match' && !room.siege.ended) {
        // 晚進來的分頁(通常是攻城戰的iframe載入比較慢)直接補發「目前當下」的即時狀態，
        // 不是補發開局當時的舊血量，這樣血條才會跟大家看到的一致
        socket.emit('siege_match_start', {
          seatOrder: room.siege.seatOrder.map(s => ({ token:s.token, name:s.name, tankKey: room.siege.players[s.token]?.tankKey })),
          matchStartAt: room.siege.matchStartAt,
          pot: room.siege.pot,
          castleHp: room.siege.castleHp,
          castleMaxHp: room.siege.castleMaxHp,
          turrets: room.siege.turrets.map(t => ({ id:t.id, key:t.key, hp:t.hp, maxHp:t.maxHp, alive:t.alive })),
          players: room.siege.seatOrder.map(s => ({ token:s.token, ...siegePublicPlayer(room.siege.players[s.token]) })),
        });
      }
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
  // ---- 選擇角色（在等待房間時就能選，選了會即時廣播給房間所有人看到）----
  socket.on('pick_character', ({ characterId }, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ ok:false, error:'找不到房間' });
    const player = room.players.get(socket.id);
    if (!player) return callback && callback({ ok:false, error:'你不在這個房間裡' });
    player.characterId = characterId;
    broadcastRoomState(roomCode);
    callback && callback({ ok:true });
  });

  socket.on('start_monopoly_game', ({ rule, startingMoney, turnLimit, enabledMinigames }, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ ok:false, error:'找不到房間' });
    if (room.hostId !== socket.id) return callback && callback({ ok:false, error:'只有房主能開始' });
    if (room.players.size < 2) return callback && callback({ ok:false, error:'至少需要2位玩家才能開始' });

    const seatOrder = Array.from(room.players.values()).map((p, i) => ({ id: p.id, token: p.token, name: p.name, seatIndex: i, characterId: p.characterId || 'char1' }));
    // 這幾個設定都做了防呆邊界，避免房主亂傳奇怪的數值把遊戲弄壞
    const safeStartingMoney = [20000, 30000, 40000, 50000].includes(Number(startingMoney)) ? Number(startingMoney) : 30000;
    const safeTurnLimit = Number.isFinite(Number(turnLimit)) ? Math.max(10, Math.min(60, Math.round(Number(turnLimit)))) : 30;
    const safeMinigames = Array.isArray(enabledMinigames) ? enabledMinigames.filter(k => AVAILABLE_MINIGAMES.includes(k)) : [];
    room.mp = {
      seatOrder,
      currentTurnSeatIdx: 0,
      rule: rule === 'turns' ? 'turns' : 'bankruptcy',
      startingMoney: safeStartingMoney,
      turnLimit: safeTurnLimit,
      enabledMinigames: safeMinigames.length > 0 ? safeMinigames : AVAILABLE_MINIGAMES.slice(),
    };
    room.started = true;

    io.to(roomCode).emit('mp_game_start', {
      seatOrder, rule: room.mp.rule, startSeatIdx: 0,
      startingMoney: room.mp.startingMoney, turnLimit: room.mp.turnLimit,
    });
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
    room.mp.lastSnapshot = snapshot; // 留一份最新快照，斷線重連時可以直接補發給重新加入的玩家
    socket.to(roomCode).emit('state_sync', { snapshot, currentTurnSeatIdx: room.mp.currentTurnSeatIdx });
  });

  // ============================================================
  // 小遊戲觸發機制（棋盤買地/被踩地/蓋房時，隨機抽一款小遊戲，強制全員參加）
  // 觸發的當下由伺服器隨機決定玩哪一款、直接用棋盤那一局既有的座位順序(room.mp.seatOrder)，
  // 不需要另外開一次「大廳」；小遊戲結束時，由伺服器判定「觸發的那個人是不是贏家」。
  // ============================================================

  // 目前已經接好連線的小遊戲：之後每完成一款新的，往這個陣列加一個名字即可
  const AVAILABLE_MINIGAMES = ['ultimate_password', 'redlight', 'ghost_tag', 'plane_shooter', 'mahjong', 'blackjack'];

  // 鬼抓人用：伺服器產生一份場地障礙物佈局，讓所有client畫面一致
  function generateGhostTagObstacles(){
    const boardHalf = 20;
    const obstacles = [];
    for (let i = 0; i < 9; i++) {
      let x, z, tries = 0;
      do {
        x = -boardHalf + 4 + Math.random() * (boardHalf * 2 - 8);
        z = -boardHalf + 4 + Math.random() * (boardHalf * 2 - 8);
        tries++;
      } while (Math.hypot(x, z) < 9 && tries < 20);
      const size = 1.6 + Math.random() * 1.0;
      obstacles.push({ x, z, size });
    }
    return obstacles;
  }

  // ============================================================
  // 麻將用：手牌隱私必須由伺服器保管並權威判定，不能信任client(否則能改本地程式碼詐胡)。
  // 這裡把單機版原本在client端的洗牌/算牌邏輯，原封不動搬到伺服器端。
  // ============================================================
  function mjBuildWall(){
    const wall = [];
    let id = 0;
    ['dot','bam','chr'].forEach(suit => {
      for (let num = 1; num <= 9; num++) {
        for (let k = 0; k < 4; k++) wall.push({ id: id++, suit, num });
      }
    });
    for (let i = wall.length-1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i+1));
      [wall[i], wall[j]] = [wall[j], wall[i]];
    }
    return wall;
  }
  function mjToCounts(tiles){
    const counts = { dot:new Array(9).fill(0), bam:new Array(9).fill(0), chr:new Array(9).fill(0) };
    tiles.forEach(t => counts[t.suit][t.num-1]++);
    return counts;
  }
  function mjCanFormMelds(counts){
    for (const suit of ['dot','bam','chr']) {
      for (let i = 0; i < 9; i++) {
        if (counts[suit][i] > 0) {
          const num = i+1;
          if (counts[suit][i] >= 3) {
            counts[suit][i] -= 3;
            if (mjCanFormMelds(counts)) { counts[suit][i] += 3; return true; }
            counts[suit][i] += 3;
          }
          if (num <= 7 && counts[suit][i+1] > 0 && counts[suit][i+2] > 0) {
            counts[suit][i]--; counts[suit][i+1]--; counts[suit][i+2]--;
            if (mjCanFormMelds(counts)) { counts[suit][i]++; counts[suit][i+1]++; counts[suit][i+2]++; return true; }
            counts[suit][i]++; counts[suit][i+1]++; counts[suit][i+2]++;
          }
          return false;
        }
      }
    }
    return true;
  }
  function mjIsWinningHand(tiles){
    if (tiles.length !== 14) return false;
    const base = mjToCounts(tiles);
    for (const suit of ['dot','bam','chr']) {
      for (let i = 0; i < 9; i++) {
        if (base[suit][i] >= 2) {
          base[suit][i] -= 2;
          const ok = mjCanFormMelds(JSON.parse(JSON.stringify(base)));
          base[suit][i] += 2;
          if (ok) return true;
        }
      }
    }
    return false;
  }
  // 私人手牌只送給該token本人的所有連線(可能同時有主棋盤分頁+小遊戲iframe兩條連線)
  function mjEmitToToken(roomCode, token, event, payload){
    const roomSockets = io.sockets.adapter.rooms.get(roomCode);
    if (!roomSockets) return;
    roomSockets.forEach(sid => {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.playerToken === token) s.emit(event, payload);
    });
  }
  function mjHandCounts(room){
    const counts = {};
    room.mj.seatOrder.forEach(s => { counts[s.token] = room.mj.hands[s.token].length; });
    return counts;
  }
  function mjBroadcastPublic(roomCode, extra){
    const room = rooms.get(roomCode);
    if (!room || !room.mj) return;
    io.to(roomCode).emit('mahjong_public_update', Object.assign({
      wallCount: room.mj.wall.length,
      currentIndex: room.mj.currentIndex,
      handCounts: mjHandCounts(room),
    }, extra || {}));
  }
  function mjStartGame(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return;
    const seatOrder = room.mp.seatOrder;
    const wall = mjBuildWall();
    const hands = {};
    seatOrder.forEach(s => { hands[s.token] = wall.splice(0, 13); });
    const triggerToken = room.activeMinigame ? room.activeMinigame.triggerToken : null;
    room.mj = {
      seatOrder, wall, hands, discardLog: [], lastDiscard: null, currentIndex: 0,
      triggerToken, finished: false, pendingToken: null, pendingType: null, pendingTimer: null,
    };
    seatOrder.forEach(s => {
      mjEmitToToken(roomCode, s.token, 'mahjong_game_start', {
        seatOrder: seatOrder.map(x => ({ token:x.token, name:x.name })),
        yourHand: hands[s.token],
        wallCount: wall.length,
        currentIndex: 0,
      });
    });
    mjDrawPhase(roomCode);
  }
  function mjDrawPhase(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.mj || room.mj.finished) return;
    const mj = room.mj;
    if (mj.wall.length === 0) { mjEndGame(roomCode, null, 'draw', null, null); return; }
    const seat = mj.seatOrder[mj.currentIndex];
    const drawn = mj.wall.pop();
    mj.hands[seat.token].push(drawn);
    mjBroadcastPublic(roomCode, { drewToken: seat.token, drewName: seat.name });
    mjEmitToToken(roomCode, seat.token, 'mahjong_your_draw', { tile: drawn, hand: mj.hands[seat.token] });

    if (mjIsWinningHand(mj.hands[seat.token])) {
      mj.pendingToken = seat.token; mj.pendingType = 'selfwin';
      mjEmitToToken(roomCode, seat.token, 'mahjong_offer_self_win', { tile: drawn });
      clearTimeout(mj.pendingTimer);
      mj.pendingTimer = setTimeout(() => mjResolveSelfWin(roomCode, seat.token, false), 12000);
    } else {
      mjAwaitDiscard(roomCode);
    }
  }
  function mjResolveSelfWin(roomCode, token, accept){
    const room = rooms.get(roomCode);
    if (!room || !room.mj || room.mj.finished) return;
    const mj = room.mj;
    if (mj.pendingType !== 'selfwin' || mj.pendingToken !== token) return;
    clearTimeout(mj.pendingTimer);
    mj.pendingToken = null; mj.pendingType = null;
    if (accept) {
      const winTile = mj.hands[token][mj.hands[token].length-1];
      mjEndGame(roomCode, token, 'self', null, winTile);
    } else {
      mjAwaitDiscard(roomCode);
    }
  }
  function mjAwaitDiscard(roomCode){
    const room = rooms.get(roomCode);
    const mj = room.mj;
    const seat = mj.seatOrder[mj.currentIndex];
    mj.pendingToken = seat.token; mj.pendingType = 'discard';
    mjEmitToToken(roomCode, seat.token, 'mahjong_await_discard', {});
    clearTimeout(mj.pendingTimer);
    mj.pendingTimer = setTimeout(() => {
      const hand = mj.hands[seat.token];
      if (!hand || !hand.length) return;
      mjResolveDiscard(roomCode, seat.token, hand[hand.length-1].id);
    }, 20000);
  }
  function mjResolveDiscard(roomCode, token, tileId){
    const room = rooms.get(roomCode);
    if (!room || !room.mj || room.mj.finished) return;
    const mj = room.mj;
    if (mj.pendingType !== 'discard' || mj.pendingToken !== token) return;
    const hand = mj.hands[token];
    const idx = hand.findIndex(t => t.id === tileId);
    if (idx < 0) return;
    clearTimeout(mj.pendingTimer);
    mj.pendingToken = null; mj.pendingType = null;
    const tile = hand.splice(idx, 1)[0];
    const seat = mj.seatOrder.find(s => s.token === token);
    mj.discardLog.push({ tile, from: seat.name });
    mj.lastDiscard = { tile, fromToken: token, fromName: seat.name };
    mjBroadcastPublic(roomCode, { discarded: { tile, fromToken: token, fromName: seat.name } });
    mjOfferHuChain(roomCode, 1);
  }
  function mjOfferHuChain(roomCode, offset){
    const room = rooms.get(roomCode);
    const mj = room.mj;
    const n = mj.seatOrder.length;
    if (offset >= n) {
      mj.currentIndex = (mj.currentIndex+1) % n;
      mjDrawPhase(roomCode);
      return;
    }
    const idx = (mj.currentIndex+offset) % n;
    const seat = mj.seatOrder[idx];
    const candidateHand = [...mj.hands[seat.token], mj.lastDiscard.tile];
    if (mjIsWinningHand(candidateHand)) {
      mj.pendingToken = seat.token; mj.pendingType = 'hu'; mj.pendingHuOffset = offset;
      mjEmitToToken(roomCode, seat.token, 'mahjong_offer_hu', { tile: mj.lastDiscard.tile, fromName: mj.lastDiscard.fromName });
      clearTimeout(mj.pendingTimer);
      mj.pendingTimer = setTimeout(() => mjResolveHu(roomCode, seat.token, false), 12000);
    } else {
      mjOfferHuChain(roomCode, offset+1);
    }
  }
  function mjResolveHu(roomCode, token, accept){
    const room = rooms.get(roomCode);
    if (!room || !room.mj || room.mj.finished) return;
    const mj = room.mj;
    if (mj.pendingType !== 'hu' || mj.pendingToken !== token) return;
    clearTimeout(mj.pendingTimer);
    const offset = mj.pendingHuOffset;
    mj.pendingToken = null; mj.pendingType = null;
    if (accept) {
      mjEndGame(roomCode, token, 'discard', mj.lastDiscard.fromName, mj.lastDiscard.tile);
    } else {
      mjOfferHuChain(roomCode, offset+1);
    }
  }
  function mjEndGame(roomCode, winnerToken, mode, loserName, winTile){
    const room = rooms.get(roomCode);
    if (!room || !room.mj) return;
    const mj = room.mj;
    mj.finished = true;
    clearTimeout(mj.pendingTimer);
    const winnerSeat = winnerToken ? mj.seatOrder.find(s => s.token === winnerToken) : null;
    io.to(roomCode).emit('mahjong_game_over', {
      winnerToken, winnerName: winnerSeat ? winnerSeat.name : null, mode, loserName, winTile,
    });
    if (room.activeMinigame && !room.activeMinigame.resultReported) {
      room.activeMinigame.resultReported = true;
      const success = !!winnerToken && winnerToken === room.activeMinigame.triggerToken;
      io.to(roomCode).emit('minigame_result', {
        winnerToken, winnerName: winnerSeat ? winnerSeat.name : '流局',
        success, reason: room.activeMinigame.reason, tileIndex: room.activeMinigame.tileIndex,
      });
      console.log(`[麻將結束] ${roomCode} 贏家:${winnerSeat?winnerSeat.name:'流局'} 觸發者成功嗎:${success}`);
      room.activeMinigame = null;
    }
    room.mj = null;
  }

  // ============================================================
  // 21點PK用：發牌/計點沒有複雜組合判斷，風險比麻將低很多，
  // 但牌堆仍要伺服器權威(不能信任client自己抽牌)，且每人手牌在該局結束前要保密。
  // ============================================================
  const BJ_SUITS = ['heart','diamond','club','spade'];
  const BJ_RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  const BJ_TOTAL_ROUNDS = 5;
  function bjBuildDeck(){
    const deck = [];
    let id = 0;
    BJ_SUITS.forEach(suit => { BJ_RANKS.forEach(rank => { deck.push({ id:id++, suit, rank }); }); });
    for (let i = deck.length-1; i > 0; i--) {
      const j = Math.floor(Math.random()*(i+1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
  }
  function bjCardValue(rank){
    if (rank === 'A') return 11;
    if (rank === 'J' || rank === 'Q' || rank === 'K') return 10;
    return parseInt(rank, 10);
  }
  function bjComputeTotal(cards){
    let total = 0, aces = 0;
    cards.forEach(c => { total += bjCardValue(c.rank); if (c.rank === 'A') aces++; });
    while (total > 21 && aces > 0) { total -= 10; aces--; }
    return total;
  }
  function bjEmitToToken(roomCode, token, event, payload){
    const roomSockets = io.sockets.adapter.rooms.get(roomCode);
    if (!roomSockets) return;
    roomSockets.forEach(sid => {
      const s = io.sockets.sockets.get(sid);
      if (s && s.data.playerToken === token) s.emit(event, payload);
    });
  }
  function bjStatuses(room){
    const statuses = {};
    room.bj.seatOrder.forEach(s => {
      statuses[s.token] = {
        busted: !!room.bj.busted[s.token], stood: !!room.bj.stood[s.token],
        handCount: (room.bj.hands[s.token] || []).length,
      };
    });
    return statuses;
  }
  function bjBroadcastPublic(roomCode, extra){
    const room = rooms.get(roomCode);
    if (!room || !room.bj) return;
    io.to(roomCode).emit('blackjack_public_update', Object.assign({
      currentIndex: room.bj.currentIndex,
      statuses: bjStatuses(room),
    }, extra || {}));
  }
  function bjStartMatch(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return;
    const seatOrder = room.mp.seatOrder;
    const triggerToken = room.activeMinigame ? room.activeMinigame.triggerToken : null;
    const wins = {};
    seatOrder.forEach(s => { wins[s.token] = 0; });
    room.bj = {
      seatOrder, currentRound: 1, wins, triggerToken, finished: false,
      deck: [], hands: {}, busted: {}, stood: {}, currentIndex: 0,
      pendingToken: null, pendingTimer: null,
    };
    bjStartRound(roomCode);
  }
  function bjStartRound(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.bj) return;
    const bj = room.bj;
    const deck = bjBuildDeck();
    bj.deck = deck; bj.hands = {}; bj.busted = {}; bj.stood = {}; bj.currentIndex = 0;
    bj.seatOrder.forEach(s => {
      bj.hands[s.token] = deck.splice(0, 2);
      bj.busted[s.token] = false;
      bj.stood[s.token] = false;
    });
    bj.seatOrder.forEach(s => {
      bjEmitToToken(roomCode, s.token, 'blackjack_round_start', {
        seatOrder: bj.seatOrder.map(x => ({ token:x.token, name:x.name, wins: bj.wins[x.token] })),
        yourHand: bj.hands[s.token],
        round: bj.currentRound, totalRounds: BJ_TOTAL_ROUNDS,
      });
    });
    bjBroadcastPublic(roomCode, {});
    bjAdvanceTurn(roomCode);
  }
  // 走到目前currentIndex這位玩家：21點自動停牌，否則詢問要牌/停牌
  function bjAdvanceTurn(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.bj || room.bj.finished) return;
    const bj = room.bj;
    if (bj.currentIndex >= bj.seatOrder.length) { bjRevealRound(roomCode); return; }
    const seat = bj.seatOrder[bj.currentIndex];
    if (bjComputeTotal(bj.hands[seat.token]) === 21) {
      bj.stood[seat.token] = true;
      bjBroadcastPublic(roomCode, {});
      bj.currentIndex++;
      bjAdvanceTurn(roomCode);
      return;
    }
    bj.pendingToken = seat.token;
    bjEmitToToken(roomCode, seat.token, 'blackjack_your_turn', {});
    clearTimeout(bj.pendingTimer);
    bj.pendingTimer = setTimeout(() => bjResolveAction(roomCode, seat.token, 'stand'), 15000);
  }
  function bjResolveAction(roomCode, token, action){
    const room = rooms.get(roomCode);
    if (!room || !room.bj || room.bj.finished) return;
    const bj = room.bj;
    const seat = bj.seatOrder[bj.currentIndex];
    if (!seat || seat.token !== token || bj.pendingToken !== token) return;
    clearTimeout(bj.pendingTimer);
    bj.pendingToken = null;

    if (action === 'hit') {
      const card = bj.deck.pop();
      bj.hands[token].push(card);
      const total = bjComputeTotal(bj.hands[token]);
      bjEmitToToken(roomCode, token, 'blackjack_your_card', { hand: bj.hands[token] });
      if (total > 21) {
        bj.busted[token] = true;
        bjBroadcastPublic(roomCode, {});
        bj.currentIndex++;
        bjAdvanceTurn(roomCode);
      } else if (total === 21) {
        bj.stood[token] = true;
        bjBroadcastPublic(roomCode, {});
        bj.currentIndex++;
        bjAdvanceTurn(roomCode);
      } else {
        // 還沒破也沒到21，繼續問同一位玩家
        bj.pendingToken = token;
        bjEmitToToken(roomCode, token, 'blackjack_your_turn', {});
        clearTimeout(bj.pendingTimer);
        bj.pendingTimer = setTimeout(() => bjResolveAction(roomCode, token, 'stand'), 15000);
      }
    } else {
      bj.stood[token] = true;
      bjBroadcastPublic(roomCode, {});
      bj.currentIndex++;
      bjAdvanceTurn(roomCode);
    }
  }
  function bjRevealRound(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.bj) return;
    const bj = room.bj;
    const totals = {};
    bj.seatOrder.forEach(s => { totals[s.token] = bjComputeTotal(bj.hands[s.token]); });
    const alive = bj.seatOrder.filter(s => !bj.busted[s.token]);
    let maxTotal = -1;
    alive.forEach(s => { if (totals[s.token] > maxTotal) maxTotal = totals[s.token]; });
    const winners = alive.filter(s => totals[s.token] === maxTotal).map(s => s.token);
    winners.forEach(t => { bj.wins[t] = (bj.wins[t]||0) + 1; });

    const isFinalRound = bj.currentRound >= BJ_TOTAL_ROUNDS;
    io.to(roomCode).emit('blackjack_round_over', {
      hands: bj.hands, totals, winners, wins: bj.wins,
      round: bj.currentRound, totalRounds: BJ_TOTAL_ROUNDS, isFinalRound,
    });
    console.log(`[21點] ${roomCode} 第${bj.currentRound}局贏家:`, winners.map(t=>bj.seatOrder.find(s=>s.token===t).name).join('、'));

    if (isFinalRound) {
      setTimeout(() => bjFinishMatch(roomCode), 3200);
    } else {
      bj.currentRound++;
      setTimeout(() => bjStartRound(roomCode), 3200);
    }
  }
  function bjFinishMatch(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.bj || room.bj.finished) return;
    const bj = room.bj;
    bj.finished = true;
    const maxWins = Math.max(...bj.seatOrder.map(s => bj.wins[s.token]));
    const champTokens = bj.seatOrder.filter(s => bj.wins[s.token] === maxWins).map(s => s.token);
    const champNames = bj.seatOrder.filter(s => champTokens.includes(s.token)).map(s => s.name);
    io.to(roomCode).emit('blackjack_match_over', { championTokens: champTokens, championNames: champNames, wins: bj.wins });

    if (room.activeMinigame && !room.activeMinigame.resultReported) {
      room.activeMinigame.resultReported = true;
      const success = champTokens.includes(room.activeMinigame.triggerToken);
      io.to(roomCode).emit('minigame_result', {
        winnerToken: champTokens[0], winnerName: champNames.join('、'),
        success, reason: room.activeMinigame.reason, tileIndex: room.activeMinigame.tileIndex,
      });
      console.log(`[21點結束] ${roomCode} 總冠軍:${champNames.join('、')} 觸發者成功嗎:${success}`);
      room.activeMinigame = null;
    }
    room.bj = null;
  }

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
    else if (gameId === 'redlight') {
      const trackLen = 100;
      const progress = {};
      seatOrder.forEach(s => { progress[s.token] = 0; });
      room.rl = {
        seatOrder, trackLen, progress,
        caughtTokens: new Set(),
        finishedToken: null,
        phase: 'idle',
        phaseEndsAt: 0,
        phaseTimer: null,
      };
      io.to(roomCode).emit('redlight_game_start', { seatOrder, trackLen, progress });
      scheduleRedlightPhase(roomCode, 'green');
    }
    else if (gameId === 'ghost_tag') {
      const itIndex = Math.floor(Math.random() * seatOrder.length);
      const obstacles = generateGhostTagObstacles();
      const matchStartAt = Date.now() + 3600; // 給棋盤翻面動畫+倒數留緩衝，所有client用同一個絕對時間起跑
      const triggerToken = room.activeMinigame ? room.activeMinigame.triggerToken : null;
      room.gt = { seatOrder, obstacles, itIndex, matchStartAt, triggerToken, finished:false };
      io.to(roomCode).emit('ghost_tag_game_start', { seatOrder, obstacles, itIndex, matchStartAt, triggerToken });
    }
    else if (gameId === 'plane_shooter') {
      const matchStartAt = Date.now() + 3600;
      const MATCH_TIME_MS = 60000;
      const scores = {};
      seatOrder.forEach(s => { scores[s.token] = 0; });
      const triggerToken = room.activeMinigame ? room.activeMinigame.triggerToken : null;
      room.ps = { seatOrder, matchStartAt, scores, triggerToken, finished:false, finalizeTimer:null, finishedTokens:new Set() };
      io.to(roomCode).emit('plane_shooter_game_start', { seatOrder, matchStartAt, triggerToken });
      // 伺服器權威終局：時間到(+一點緩衝)後，不管有沒有收到每個人主動回報，都用目前已知最高分決勝負
      room.ps.finalizeTimer = setTimeout(() => finalizePlaneShooter(roomCode), MATCH_TIME_MS + 3600 + 1500);
    }
    else if (gameId === 'mahjong') {
      mjStartGame(roomCode);
    }
    else if (gameId === 'blackjack') {
      bjStartMatch(roomCode);
    }
    // 全部6款都接好了！之後如果要再加新的小遊戲，比照上面的模式加 else if 分支即可
  }

  function finalizePlaneShooter(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.ps || room.ps.finished) return;
    room.ps.finished = true;
    let winnerToken = null, winnerScore = -1;
    for (const [token, score] of Object.entries(room.ps.scores)) {
      if (score > winnerScore) { winnerScore = score; winnerToken = token; }
    }
    const winnerSeat = room.ps.seatOrder.find(s => s.token === winnerToken);
    if (room.activeMinigame && !room.activeMinigame.resultReported) {
      room.activeMinigame.resultReported = true;
      const success = winnerToken === room.activeMinigame.triggerToken;
      io.to(roomCode).emit('minigame_result', {
        winnerToken, winnerName: winnerSeat ? winnerSeat.name : '未知',
        success, reason: room.activeMinigame.reason, tileIndex: room.activeMinigame.tileIndex,
      });
      console.log(`[飛機射擊結束] ${roomCode} 最高分:${winnerSeat?winnerSeat.name:'?'}(${winnerScore}) 觸發者成功嗎:${success}`);
      room.activeMinigame = null;
    }
    room.ps = null;
  }

  // ---- 123木頭人：伺服器權威控制綠燈/紅燈時間並廣播絕對時間戳，各端依此自行判定紅燈時是否放開 ----
  function scheduleRedlightPhase(roomCode, phase){
    const room = rooms.get(roomCode);
    if (!room || !room.rl) return; // 遊戲已結束/房間已消失，停止排程鏈
    const dur = phase === 'green'
      ? (1600 + Math.random() * 1800)
      : (1300 + Math.random() * 800);
    room.rl.phase = phase;
    room.rl.phaseEndsAt = Date.now() + dur;
    io.to(roomCode).emit('redlight_phase', { phase, phaseEndsAt: room.rl.phaseEndsAt });
    clearTimeout(room.rl.phaseTimer);
    room.rl.phaseTimer = setTimeout(() => {
      scheduleRedlightPhase(roomCode, phase === 'green' ? 'red' : 'green');
    }, dur);
  }

  socket.on('trigger_minigame', ({ reason, tileIndex }, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return callback && callback({ ok:false, error:'尚未開局' });
    const triggerSeat = room.mp.seatOrder.find(s => s.token === socket.data.playerToken);
    if (!triggerSeat) return callback && callback({ ok:false, error:'找不到你的座位' });

    // 用「不放回抽籤」而非每次都重新均勻隨機：把可用的小遊戲洗牌放進一個隨房間持有的牌堆，
    // 每次觸發從牌堆抽一張，抽完再重新洗牌放回去。這樣可以保證每一輪內每款都會各出現一次，
    // 不會像單純均勻隨機那樣運氣不好時連續很多次都抽不到某一款。
    const pool = (room.mp.enabledMinigames && room.mp.enabledMinigames.length > 0) ? room.mp.enabledMinigames : AVAILABLE_MINIGAMES;
    if (!room.minigameBag || room.minigameBag.length === 0) {
      room.minigameBag = pool.slice();
      for (let i = room.minigameBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [room.minigameBag[i], room.minigameBag[j]] = [room.minigameBag[j], room.minigameBag[i]];
      }
    }
    const gameId = room.minigameBag.pop();
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
    if (room.rl) { clearTimeout(room.rl.phaseTimer); room.rl = null; }
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
  // 123木頭人小遊戲 連線同步：伺服器只負責綠燈/紅燈的絕對時間戳與「誰先衝線」的判定，
  // 移動進度與紅燈誤觸由各自client自行判斷後回報(信任client)，符合這個專案既有的輕量同步模式。
  // ============================================================

  // 玩家在綠燈時持續回報自己的進度，伺服器轉發給房間其他人套用在畫面上
  socket.on('redlight_move', ({ progress }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.rl) return;
    const token = socket.data.playerToken;
    if (!(token in room.rl.progress)) return;
    if (typeof progress !== 'number' || progress < 0 || progress > room.rl.trackLen) return;
    room.rl.progress[token] = progress;
    socket.to(roomCode).emit('redlight_move', { token, progress });
  });

  // 玩家在紅燈還按著移動被自己端偵測到「被抓到」，回報後廣播讓大家看到退回起點的動畫
  socket.on('redlight_caught', () => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.rl) return;
    const token = socket.data.playerToken;
    if (!(token in room.rl.progress)) return;
    room.rl.progress[token] = 0;
    room.rl.caughtTokens.add(token);
    io.to(roomCode).emit('redlight_player_caught', { token });
  });

  // 第一個回報「衝線」的玩家就是贏家(先到先贏，之後的回報一律忽略)
  socket.on('redlight_finished', (data, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.rl || room.rl.finishedToken) return callback && callback({ ok:false });
    const token = socket.data.playerToken;
    const seat = room.rl.seatOrder.find(s => s.token === token);
    if (!seat) return callback && callback({ ok:false });
    room.rl.finishedToken = token;
    clearTimeout(room.rl.phaseTimer);
    callback && callback({ ok:true });

    if (room.activeMinigame && !room.activeMinigame.resultReported) {
      room.activeMinigame.resultReported = true;
      const success = token === room.activeMinigame.triggerToken;
      io.to(roomCode).emit('minigame_result', {
        winnerToken: token, winnerName: seat.name, success,
        reason: room.activeMinigame.reason, tileIndex: room.activeMinigame.tileIndex,
      });
      console.log(`[123木頭人結束] ${roomCode} 贏家:${seat.name} 觸發者成功嗎:${success}`);
      room.rl = null;
      room.activeMinigame = null;
    }
  });

  // ============================================================
  // 鬼抓人小遊戲 連線同步：伺服器只決定「誰是鬼、障礙物長怎樣、絕對起跑時間」，
  // 移動位置由各自client自己算好本地玩家的位置後廣播出去(信任client)，
  // 遠端玩家的畫面純粹套用收到的位置；抓人判定也是「鬼」的client自己判定後廣播；
  // 誰贏誰輸則由「觸發的那個人」自己的client判斷自己最終是否成功，直接回報結果
  // (因為這款遊戲可能同時有多個逃跑者「贏」，沒有唯一贏家可比對，跟終極密碼/123木頭人不同模式)。
  // ============================================================

  socket.on('ghosttag_move', ({ x, z }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.gt) return;
    const token = socket.data.playerToken;
    if (typeof x !== 'number' || typeof z !== 'number') return;
    socket.to(roomCode).emit('ghosttag_move', { token, x, z });
  });

  socket.on('ghosttag_eliminate', ({ targetToken }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.gt || room.gt.finished) return;
    // 只信任「鬼」自己的client送出的淘汰判定，避免其他人亂廣播淘汰別人
    const itSeat = room.gt.seatOrder[room.gt.itIndex];
    if (!itSeat || itSeat.token !== socket.data.playerToken) return;
    io.to(roomCode).emit('ghosttag_eliminate', { targetToken });
  });

  // 「觸發式強制參加」共用的自我回報結果管道：只信任目前這場小遊戲的觸發者自己回報
  socket.on('report_trigger_outcome', ({ success }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.activeMinigame || room.activeMinigame.resultReported) return;
    if (socket.data.playerToken !== room.activeMinigame.triggerToken) return;
    room.activeMinigame.resultReported = true;
    const triggerSeat = (room.gt && room.gt.seatOrder.find(s => s.token === socket.data.playerToken)) || {};
    io.to(roomCode).emit('minigame_result', {
      winnerToken: socket.data.playerToken,
      winnerName: room.activeMinigame.triggerName || triggerSeat.name,
      success: !!success,
      reason: room.activeMinigame.reason, tileIndex: room.activeMinigame.tileIndex,
    });
    console.log(`[鬼抓人結束] ${roomCode} 觸發者:${room.activeMinigame.triggerName} 成功嗎:${!!success}`);
    if (room.gt) { room.gt.finished = true; room.gt = null; }
    room.activeMinigame = null;
  });

  // ============================================================
  // 飛機射擊小遊戲 連線同步：每個真人玩家各自本地模擬「自己」那架飛機的完整玩法，
  // 定期回報自己的位置/血量/分數，伺服器只單純轉發給其他人當作畫面上的裝飾疊圖；
  // 誰贏誰輸則是伺服器權威計時器在比賽結束時，比較所有人回報過的最高分數來決定。
  // ============================================================

  socket.on('planeshooter_move', ({ x, y, hp, score, alive }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.ps) return;
    const token = socket.data.playerToken;
    if (!(token in room.ps.scores)) return;
    if (typeof score === 'number') room.ps.scores[token] = score;
    socket.to(roomCode).emit('planeshooter_move', { token, x, y, hp, score, alive });
  });

  // 玩家自己判定比賽已結束(死亡或達到60秒)時，提前送出最終分數；
  // 如果房間裡所有真人玩家都已經回報結束，就不用死等伺服器的權威計時器，直接提前結算，
  // 否則仍統一交給伺服器的權威計時器處理，這裡先更新分數即可，避免空窗顯示分數不同步
  socket.on('planeshooter_finished', ({ score }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.ps) return;
    const token = socket.data.playerToken;
    if (!(token in room.ps.scores)) return;
    if (typeof score === 'number') room.ps.scores[token] = score;
    room.ps.finishedTokens.add(token);
    if (room.ps.finishedTokens.size >= room.ps.seatOrder.length) {
      clearTimeout(room.ps.finalizeTimer);
      finalizePlaneShooter(roomCode);
    }
  });

  // ============================================================
  // 麻將小遊戲 連線事件：這三個動作都必須經伺服器驗證(是不是輪到你/牌是不是真的在你手上/
  // 胡牌是不是真的成立)，不能信任client直接送結果，否則能改本地程式碼詐胡。
  // ============================================================
  socket.on('mahjong_discard', ({ tileId }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    mjResolveDiscard(roomCode, socket.data.playerToken, tileId);
  });
  socket.on('mahjong_confirm_self_win', ({ accept }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    mjResolveSelfWin(roomCode, socket.data.playerToken, !!accept);
  });
  socket.on('mahjong_hu_decision', ({ accept }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    mjResolveHu(roomCode, socket.data.playerToken, !!accept);
  });

  // ============================================================
  // 21點PK 連線事件：要牌/停牌都必須是伺服器目前正在等待的那位玩家才會生效，
  // 牌堆/發牌一律伺服器權威，client端只負責顯示。
  // ============================================================
  socket.on('blackjack_action', ({ action }) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    bjResolveAction(roomCode, socket.data.playerToken, action === 'hit' ? 'hit' : 'stand');
  });

  // ============================================================
  // 攻城戰（團隊奪寶挑戰）連線同步
  // 不是 trigger_minigame 那 6 款——這是從棋盤畫面一個獨立按鈕直接啟動的
  // 團隊玩法，至少需要 2 位玩家。設計原則：
  // ① 城堡/砲塔/玩家的血量一律由伺服器保管、伺服器說了算，不能讓每個人
  //    自己各算各的，不然畫面血量會兜不起來；
  // ② 「我打中了城堡/砲塔多少傷害」還是信任開火那個玩家自己的client回報
  //    （這款遊戲沒有做伺服器端的3D碰撞判定），但伺服器會把回報的傷害
  //    夾在該玩家戰車等級「應該」打出的傷害上限內，避免明顯異常的數值；
  //    移動/瞄準也是同一套「信任client、伺服器只轉發」的作法；
  // ③ 砲塔反擊玩家則完全由伺服器自己跑計時器決定，不假手任何一個client，
  //    這樣才不會有「誰是砲塔AI的代理人」這種還要處理斷線的麻煩。
  // ============================================================

  const SIEGE_TANK_DEFS = {
    tank_light:  { attack:40,  hp:2500, fireInterval:0.333 },
    tank_medium: { attack:70,  hp:3200, fireInterval:0.25 },
    tank_heavy:  { attack:100, hp:4000, fireInterval:0.2 },
  };
  const SIEGE_TURRET_DEFS = [
    { key:'turret_missile', attack:100, maxHp:50000, count:3, fireInterval:0.333 },
    { key:'turret_gatling', attack:80,  maxHp:35000, count:4, fireInterval:0.2 },
    { key:'turret_twin',    attack:60,  maxHp:25000, count:5, fireInterval:0.25 },
    { key:'turret_flame',   attack:40,  maxHp:17500, count:6, fireInterval:0.286 },
    { key:'turret_basic',   attack:20,  maxHp:10000, count:6, fireInterval:0.333 },
  ];
  const SIEGE_CASTLE_MAX_HP = 200000;
  const SIEGE_MATCH_TIME_MS = 30 * 60 * 1000;

  // 只挑選要送上網路的欄位，絕對不要把整個 player state 物件直接展開送出——
  // 裡面的 respawnTimer 是 Node 的 Timeout 物件，一旦被 JSON/socket.io 序列化
  // 就會整個炸開(呼叫堆疊爆炸)，這是很容易不小心踩到的地雷
  function siegePublicPlayer(p){
    if (!p) return null;
    return { tankKey:p.tankKey, hp:p.hp, maxHp:p.maxHp, alive:p.alive, lives:p.lives, permanentlyDead:p.permanentlyDead, damageDealt:p.damageDealt };
  }

  function siegeAliveTokens(room){
    return room.siege.seatOrder
      .map(s => s.token)
      .filter(tok => { const p = room.siege.players[tok]; return p && p.alive && !p.permanentlyDead; });
  }

  function siegeCheckTeamWipe(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.ended) return;
    const allDead = room.siege.seatOrder.every(s => {
      const p = room.siege.players[s.token];
      return p && p.permanentlyDead;
    });
    if (allDead) siegeEndMatch(roomCode, 'wipe');
  }

  // 對某位玩家套用傷害：扣血、判斷陣亡/重生/永久陣亡，回傳最新狀態方便廣播
  function siegeApplyDamageToPlayer(roomCode, token, dmg){
    const room = rooms.get(roomCode);
    if (!room || !room.siege) return null;
    const p = room.siege.players[token];
    if (!p || !p.alive) return null;
    p.hp = Math.max(0, p.hp - dmg);
    if (p.hp <= 0) {
      p.alive = false;
      p.lives -= 1;
      if (p.lives <= 0) {
        p.permanentlyDead = true;
      } else {
        clearTimeout(p.respawnTimer);
        p.respawnTimer = setTimeout(() => {
          const room2 = rooms.get(roomCode);
          if (!room2 || !room2.siege || room2.siege.ended) return;
          const p2 = room2.siege.players[token];
          if (!p2 || p2.permanentlyDead) return;
          p2.respawnTimer = null;
          p2.alive = true;
          p2.hp = p2.maxHp;
          io.to(roomCode).emit('siege_player_respawn', { token, hp: p2.hp });
        }, 5000);
      }
    }
    return p;
  }

  // 砲塔反擊計時器：每座存活砲塔各自照自己的射速獨立排程，完全伺服器權威，
  // 不需要任何一個玩家的client代跑砲塔AI（也就不用煩惱「代跑的人斷線怎麼辦」）
  function siegeScheduleTurretFire(roomCode, turretId){
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.ended) return;
    const turret = room.siege.turrets.find(t => t.id === turretId);
    if (!turret || !turret.alive) return;
    const def = SIEGE_TURRET_DEFS.find(d => d.key === turret.key);
    turret.fireTimer = setTimeout(() => {
      const room2 = rooms.get(roomCode);
      if (!room2 || !room2.siege || room2.siege.ended) return;
      const t2 = room2.siege.turrets.find(x => x.id === turretId);
      if (!t2 || !t2.alive) return;
      const alive = siegeAliveTokens(room2);
      if (alive.length > 0) {
        const targetToken = alive[Math.floor(Math.random() * alive.length)];
        const p = siegeApplyDamageToPlayer(roomCode, targetToken, def.attack);
        if (p) {
          io.to(roomCode).emit('siege_turret_fired', {
            turretId, targetToken, damage: def.attack,
            hp: p.hp, alive: p.alive, lives: p.lives, permanentlyDead: p.permanentlyDead,
          });
          if (p.permanentlyDead) siegeCheckTeamWipe(roomCode);
        }
      }
      siegeScheduleTurretFire(roomCode, turretId);
    }, def.fireInterval * 1000);
  }

  function siegeClearAllTimers(room){
    if (!room || !room.siege) return;
    (room.siege.turrets || []).forEach(t => clearTimeout(t.fireTimer));
    Object.values(room.siege.players || {}).forEach(p => clearTimeout(p.respawnTimer));
    clearTimeout(room.siege.endTimer);
  }

  function siegeStartMatch(roomCode){
    const room = rooms.get(roomCode);
    if (!room || !room.siege) return;
    const seatOrder = room.siege.seatOrder;
    const n = seatOrder.length;

    room.siege.players = {};
    seatOrder.forEach(s => {
      const tankKey = room.siege.tankPicks[s.token] || 'tank_medium';
      const def = SIEGE_TANK_DEFS[tankKey] || SIEGE_TANK_DEFS.tank_medium;
      room.siege.players[s.token] = {
        tankKey, hp: def.hp, maxHp: def.hp, alive: true, lives: 3,
        permanentlyDead: false, damageDealt: 0, respawnTimer: null,
      };
    });

    let turretId = 0;
    room.siege.turrets = [];
    SIEGE_TURRET_DEFS.forEach(def => {
      for (let i = 0; i < def.count; i++) {
        room.siege.turrets.push({ id: turretId++, key: def.key, hp: def.maxHp, maxHp: def.maxHp, alive: true, fireTimer: null });
      }
    });

    room.siege.castleHp = SIEGE_CASTLE_MAX_HP;
    room.siege.castleMaxHp = SIEGE_CASTLE_MAX_HP;
    room.siege.pot = 50000 + 50000 * (n - 1);
    room.siege.matchStartAt = Date.now() + 3600; // 給棋盤翻面動畫留緩衝，所有client同一個絕對時間起跑
    room.siege.phase = 'match';
    room.siege.ended = false;

    io.to(roomCode).emit('siege_match_start', {
      seatOrder: seatOrder.map(s => ({ token: s.token, name: s.name, tankKey: room.siege.players[s.token].tankKey })),
      matchStartAt: room.siege.matchStartAt,
      pot: room.siege.pot,
      castleHp: room.siege.castleHp,
      castleMaxHp: room.siege.castleMaxHp,
      turrets: room.siege.turrets.map(t => ({ id: t.id, key: t.key, hp: t.hp, maxHp: t.maxHp, alive: t.alive })),
      players: seatOrder.map(s => ({ token: s.token, ...siegePublicPlayer(room.siege.players[s.token]) })),
    });

    room.siege.turrets.forEach(t => siegeScheduleTurretFire(roomCode, t.id));
    room.siege.endTimer = setTimeout(() => siegeEndMatch(roomCode, 'timeout'), SIEGE_MATCH_TIME_MS + 3600 + 1500);
    console.log(`[攻城戰開局] ${roomCode} 玩家:`, seatOrder.map(s => s.name).join(', '));
  }

  function siegeEndMatch(roomCode, reason){
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.ended) return;
    room.siege.ended = true;
    siegeClearAllTimers(room);

    // 獎金池每 5 秒 +100，這裡在結算當下才一次算出「累計到現在總共多少」，
    // 不用另外開一個計時器每 5 秒跑一次去累加，數學上結果一樣
    const elapsedMs = Math.max(0, Date.now() - room.siege.matchStartAt);
    const finalPot = room.siege.pot + Math.floor(elapsedMs / 5000) * 100;

    const seatOrder = room.siege.seatOrder;
    const totalDmg = seatOrder.reduce((s, seat) => s + (room.siege.players[seat.token]?.damageDealt || 0), 0);
    const settlement = seatOrder.map(seat => {
      const p = room.siege.players[seat.token] || { damageDealt: 0 };
      const share = totalDmg > 0 ? p.damageDealt / totalDmg : 1 / seatOrder.length;
      return { token: seat.token, name: seat.name, damageDealt: p.damageDealt, payout: Math.round(finalPot * share) };
    }).sort((a, b) => b.payout - a.payout);

    io.to(roomCode).emit('siege_match_end', { reason, pot: finalPot, settlement });
    console.log(`[攻城戰結束] ${roomCode} 原因:${reason}`);
    room.siege = null;
  }

  // ---- 房主啟動攻城戰大廳（至少需要2位玩家）----
  socket.on('start_siege_game', (data, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ ok:false, error:'找不到房間' });
    // 攻城戰是從獨立的 siege_game.html 分頁/iframe 觸發的，那條連線的 socket.id
    // 跟大廳/棋盤主連線的 socket.id 不是同一個，不能沿用「必須是 room.hostId」
    // 這種比對方式；改成只要這個 playerToken 本來就是房間裡的成員即可觸發，
    // 任何一位玩家按下「發起攻城戰」都算數（先到先贏，之後的重複觸發會被
    // 下面的 room.siege 檢查擋掉）。
    const isMember = Array.from(room.players.values()).some(p => p.token === socket.data.playerToken);
    if (!isMember) return callback && callback({ ok:false, error:'你不在這個房間裡' });
    if (room.players.size < 2) return callback && callback({ ok:false, error:'攻城戰至少需要2位玩家' });
    if (room.siege) return callback && callback({ ok:false, error:'攻城戰已經在進行中' });

    const seatOrder = Array.from(room.players.values()).map(p => ({ id: p.id, token: p.token, name: p.name }));
    room.siege = { phase:'tankpick', seatOrder, tankPicks:{}, readySet:new Set(), players:{}, turrets:[], ended:false };
    io.to(roomCode).emit('siege_lobby_start', { seatOrder });
    console.log(`[攻城戰大廳開啟] ${roomCode}`);
    callback && callback({ ok:true });
  });

  socket.on('siege_pick_tank', ({ tankKey }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.phase !== 'tankpick') return;
    if (!SIEGE_TANK_DEFS[tankKey]) return;
    room.siege.tankPicks[socket.data.playerToken] = tankKey;
    io.to(roomCode).emit('siege_picks_update', { tankPicks: room.siege.tankPicks });
  });

  socket.on('siege_ready', (data, callback) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.phase !== 'tankpick') return callback && callback({ ok:false });
    room.siege.readySet.add(socket.data.playerToken);
    io.to(roomCode).emit('siege_ready_update', { readyTokens: Array.from(room.siege.readySet) });
    callback && callback({ ok:true });
    if (room.siege.readySet.size >= room.siege.seatOrder.length) siegeStartMatch(roomCode);
  });

  socket.on('siege_move', ({ x, z, rotY }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.phase !== 'match') return;
    if (typeof x !== 'number' || typeof z !== 'number') return;
    socket.to(roomCode).emit('siege_move', { token: socket.data.playerToken, x, z, rotY });
  });

  socket.on('siege_hit_castle', ({ amount }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.phase !== 'match' || room.siege.ended) return;
    const token = socket.data.playerToken;
    const p = room.siege.players[token];
    if (!p || !p.alive) return;
    const def = SIEGE_TANK_DEFS[p.tankKey] || SIEGE_TANK_DEFS.tank_medium;
    const dmg = Math.max(0, Math.min(Number(amount) || 0, def.attack));
    room.siege.castleHp = Math.max(0, room.siege.castleHp - dmg);
    p.damageDealt += dmg;
    io.to(roomCode).emit('siege_castle_hp', { hp: room.siege.castleHp, by: token, amount: dmg });
    if (room.siege.castleHp <= 0) siegeEndMatch(roomCode, 'victory');
  });

  socket.on('siege_hit_turret', ({ turretId, amount }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.siege || room.siege.phase !== 'match' || room.siege.ended) return;
    const token = socket.data.playerToken;
    const p = room.siege.players[token];
    const turret = room.siege.turrets.find(t => t.id === turretId);
    if (!p || !p.alive || !turret || !turret.alive) return;
    const def = SIEGE_TANK_DEFS[p.tankKey] || SIEGE_TANK_DEFS.tank_medium;
    const dmg = Math.max(0, Math.min(Number(amount) || 0, def.attack));
    turret.hp = Math.max(0, turret.hp - dmg);
    p.damageDealt += dmg;
    if (turret.hp <= 0 && turret.alive) {
      turret.alive = false;
      clearTimeout(turret.fireTimer);
    }
    io.to(roomCode).emit('siege_turret_hp', { turretId, hp: turret.hp, alive: turret.alive, by: token, amount: dmg });
  });

  socket.on('siege_chat', ({ msg }) => {
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.siege) return;
    const seat = room.siege.seatOrder.find(s => s.token === socket.data.playerToken);
    if (!seat || typeof msg !== 'string') return;
    io.to(roomCode).emit('siege_chat', { token: seat.token, name: seat.name, msg: msg.slice(0, 40) });
  });

  // ---- 簡易測試訊息廣播（驗證即時同步用，之後會換成真正的遊戲事件） ----
  socket.on('test_ping', (msg) => {
    const roomCode = socket.data.roomCode;
    if (!roomCode) return;
    io.to(roomCode).emit('test_pong', { from: socket.id, msg, at: Date.now() });
  });

  // ---- 離線處理 ----
  // 遊戲已經開始的房間，斷線不會馬上把人踢出去：先標記成「離線中」保留10分鐘，
  // 這段時間內用同一個 playerToken 重新整理頁面回來，可以直接接回原本的座位跟
  // 進度；10分鐘內沒回來，或房間根本還沒開始遊戲，才會真的把人移除。
  function finalizeDisconnect(roomCode, socketId) {
    const room = rooms.get(roomCode);
    if (!room) return;
    const leavingToken = room.players.get(socketId)?.token;
    room.players.delete(socketId);

    if (room.players.size === 0) {
      rooms.delete(roomCode);
      console.log(`[房間清空刪除] ${roomCode}`);
      return;
    }

    if (room.hostId === socketId) {
      const nextHost = room.players.keys().next().value;
      room.hostId = nextHost;
      room.players.get(nextHost).isHost = true;
      console.log(`[房主轉移] ${roomCode} -> ${nextHost}`);
    }

    if (room.mp) io.to(roomCode).emit('mp_player_left', {});
    if (room.pw) io.to(roomCode).emit('pw_player_left', {});
    if (room.rl) { clearTimeout(room.rl.phaseTimer); room.rl = null; io.to(roomCode).emit('rl_player_left', {}); }
    if (room.gt) { room.gt = null; io.to(roomCode).emit('gt_player_left', {}); }
    if (room.ps) { clearTimeout(room.ps.finalizeTimer); room.ps = null; io.to(roomCode).emit('ps_player_left', {}); }
    if (room.mj) { clearTimeout(room.mj.pendingTimer); room.mj = null; io.to(roomCode).emit('mj_player_left', {}); }
    if (room.bj) { clearTimeout(room.bj.pendingTimer); room.bj = null; io.to(roomCode).emit('bj_player_left', {}); }
    if (room.siege) {
      const token = leavingToken;
      if (room.siege.phase === 'tankpick') {
        siegeClearAllTimers(room);
        room.siege = null;
        io.to(roomCode).emit('siege_player_left', { token, cancelled: true });
      } else if (room.siege.phase === 'match' && !room.siege.ended) {
        const p = room.siege.players[token];
        if (p && !p.permanentlyDead) {
          p.alive = false;
          p.permanentlyDead = true;
          clearTimeout(p.respawnTimer);
        }
        io.to(roomCode).emit('siege_player_left', { token, cancelled: false });
        siegeCheckTeamWipe(roomCode);
      }
    }

    broadcastRoomState(roomCode);
  }

  socket.on('disconnect', () => {
    const roomCode = socket.data.roomCode;
    console.log(`[斷線] ${socket.id} (room: ${roomCode || '無'})`);
    if (!roomCode) return;
    const room = rooms.get(roomCode);
    if (!room) return;

    // 這條連線如果不在 room.players 裡，代表它只是小遊戲 iframe 用
    // join_as_participant 接上的分身連線，不是玩家的主連線。
    // 每玩完一場小遊戲、iframe 關閉時都會觸發這裡，若照下面整套「玩家離線」
    // 處理走一遍，會誤判成真人斷線，所以這種連線直接忽略即可。
    if (!room.players.has(socket.id)) return;

    // 遊戲已經開始的話，給一段緩衝時間讓玩家有機會重新整理頁面接回來，
    // 不要馬上把人移除、觸發房主轉移或取消小遊戲這些連鎖反應
    if (room.started) {
      const player = room.players.get(socket.id);
      player.disconnected = true;
      player.disconnectedAt = Date.now();
      player.graceTimer = setTimeout(() => finalizeDisconnect(roomCode, socket.id), RECONNECT_GRACE_MS);
      broadcastRoomState(roomCode);
      console.log(`[離線保留座位] ${roomCode} ${player.name}（10分鐘內可重連）`);
      return;
    }

    finalizeDisconnect(roomCode, socket.id);
  });

  // ---- 重新連線：用舊的 playerToken 認回原本保留的座位 ----
  socket.on('rejoin_room', ({ roomCode, playerToken }, callback) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room) return callback && callback({ ok:false, error:'房間已經不存在了（可能超過保留時間或已經結束）' });

    let oldSocketId = null, player = null;
    for (const [sid, p] of room.players.entries()) {
      if (p.token === playerToken && p.disconnected) { oldSocketId = sid; player = p; break; }
    }
    if (!player) return callback && callback({ ok:false, error:'找不到可以重新加入的座位（可能已經超過10分鐘保留時間）' });

    clearTimeout(player.graceTimer);
    room.players.delete(oldSocketId);
    player.id = socket.id;
    player.disconnected = false;
    player.disconnectedAt = null;
    player.graceTimer = null;
    room.players.set(socket.id, player);
    if (room.hostId === oldSocketId) room.hostId = socket.id;

    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = playerToken;

    console.log(`[重新連線] ${roomCode} ${player.name}`);
    broadcastRoomState(roomCode);
    callback && callback({
      ok: true,
      roomCode,
      playerToken,
      state: getPublicRoomState(room),
      mpStarted: !!room.mp,
      mpGameStart: room.mp ? { seatOrder: room.mp.seatOrder, rule: room.mp.rule, startSeatIdx: room.mp.currentTurnSeatIdx } : null,
      mpSnapshot: room.mp ? (room.mp.lastSnapshot || null) : null,
      mpCurrentTurnSeatIdx: room.mp ? room.mp.currentTurnSeatIdx : null,
    });
  });

  // ============================================================
  // 存檔 / 讀取進度 / 歷史排行榜（都要有設定 MONGODB_URI 才會運作）
  // ============================================================
  const { ObjectId } = require('mongodb');

  // 手動存檔：任何一位還在房間裡的玩家都可以按（例如隊友斷線時，其他人想先存檔）
  socket.on('save_game_progress', ({ note }, callback) => {
    if (!dbReady) return callback && callback({ ok:false, error:'存檔功能目前未啟用（尚未設定資料庫）' });
    const roomCode = socket.data.roomCode;
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return callback && callback({ ok:false, error:'目前沒有進行中的棋盤遊戲可以儲存' });
    const me = room.players.get(socket.id);
    const doc = {
      savedAt: new Date(),
      savedBy: me ? me.name : '未知玩家',
      note: (note || '').slice(0, 40),
      seatOrder: room.mp.seatOrder,
      rule: room.mp.rule,
      currentTurnSeatIdx: room.mp.currentTurnSeatIdx,
      snapshot: room.mp.lastSnapshot || null,
    };
    db.collection('saves').insertOne(doc)
      .then(r => { console.log(`[存檔] ${roomCode} by ${doc.savedBy}`); callback && callback({ ok:true, saveId: r.insertedId.toString() }); })
      .catch(err => callback && callback({ ok:false, error:'儲存失敗：'+err.message }));
  });

  // 瀏覽最近的存檔清單（給登入畫面的「存取遊戲進度」用）
  socket.on('list_saves', (data, callback) => {
    if (!dbReady) return callback && callback({ ok:false, error:'存檔功能目前未啟用（尚未設定資料庫）' });
    db.collection('saves').find({}).sort({ savedAt:-1 }).limit(20).toArray()
      .then(docs => callback && callback({ ok:true, saves: docs.map(d => ({
        id: d._id.toString(), savedAt: d.savedAt, savedBy: d.savedBy, note: d.note,
        players: d.seatOrder.map(s => s.name), rule: d.rule,
      })) }))
      .catch(err => callback && callback({ ok:false, error:err.message }));
  });

  // 從存檔開一個新房間：第一個讀檔的人先建房，其他原本玩家再用同一組 saveId
  // 依序加入(join_room_from_save)，依序認回原本各自的座位；全部認完自動開局
  socket.on('create_room_from_save', ({ saveId, playerName }, callback) => {
    if (!dbReady) return callback && callback({ ok:false, error:'存檔功能目前未啟用（尚未設定資料庫）' });
    db.collection('saves').findOne({ _id: new ObjectId(saveId) })
      .then(doc => {
        if (!doc) return callback && callback({ ok:false, error:'找不到這筆存檔' });
        const roomCode = generateRoomCode();
        const token = generateToken();
        const seatOrder = doc.seatOrder.map(s => ({ ...s, token: null })); // 座位先空著，等原本玩家依序認回
        const room = { players: new Map(), hostId: socket.id, hostToken: token, createdAt: Date.now(), started: true };
        room.mp = { seatOrder, currentTurnSeatIdx: doc.currentTurnSeatIdx, rule: doc.rule, lastSnapshot: doc.snapshot, loadedFromSave: true };
        rooms.set(roomCode, room);

        // 開房的這個人直接認回座位 0
        seatOrder[0].token = token;
        seatOrder[0].id = socket.id; // 這個seat.id是用來讓client判斷「這是不是我自己」用的，要跟著換成新的socket.id
        room.players.set(socket.id, { id:socket.id, token, name:seatOrder[0].name, isHost:true, ready:false, characterId:null });

        socket.join(roomCode);
        socket.data.roomCode = roomCode;
        socket.data.playerToken = token;
        console.log(`[讀檔開房] ${roomCode} <- 存檔 ${saveId}`);
        const claimed = seatOrder.length <= 1;
        if (claimed) mpBroadcastLoadedGameStart(roomCode);
        callback && callback({ ok:true, roomCode, playerToken:token, yourSeatName:seatOrder[0].name, remainingSeats: seatOrder.slice(1).map(s=>s.name) });
      })
      .catch(err => callback && callback({ ok:false, error:err.message }));
  });

  // 原本其他玩家用同一個房號加入，依序認回剩下的座位
  socket.on('join_room_from_save', ({ roomCode }, callback) => {
    roomCode = (roomCode || '').toUpperCase().trim();
    const room = rooms.get(roomCode);
    if (!room || !room.mp || !room.mp.loadedFromSave) return callback && callback({ ok:false, error:'找不到這個讀檔房間' });
    const seatOrder = room.mp.seatOrder;
    const nextSeat = seatOrder.find(s => !s.token);
    if (!nextSeat) return callback && callback({ ok:false, error:'這筆存檔的座位都已經有人認領了' });

    const token = generateToken();
    nextSeat.token = token;
    nextSeat.id = socket.id;
    room.players.set(socket.id, { id:socket.id, token, name:nextSeat.name, isHost:false, ready:false, characterId:null });
    socket.join(roomCode);
    socket.data.roomCode = roomCode;
    socket.data.playerToken = token;
    console.log(`[讀檔認領座位] ${roomCode} -> ${nextSeat.name}`);
    broadcastRoomState(roomCode);

    const stillWaiting = seatOrder.filter(s => !s.token).map(s => s.name);
    callback && callback({ ok:true, roomCode, playerToken:token, yourSeatName:nextSeat.name, remainingSeats: stillWaiting });
    if (stillWaiting.length === 0) mpBroadcastLoadedGameStart(roomCode);
  });

  function mpBroadcastLoadedGameStart(roomCode) {
    const room = rooms.get(roomCode);
    if (!room || !room.mp) return;
    io.to(roomCode).emit('mp_game_start_from_save', {
      seatOrder: room.mp.seatOrder, rule: room.mp.rule, startSeatIdx: room.mp.currentTurnSeatIdx, snapshot: room.mp.lastSnapshot,
    });
    console.log(`[讀檔開局] ${roomCode} 座位全部認領完成`);
  }

  // 一場遊戲真正分出勝負時，棋盤那邊會呼叫這個把結果記進歷史排行榜
  socket.on('submit_leaderboard_entry', ({ rule, results }) => {
    if (!dbReady || !Array.isArray(results)) return;
    db.collection('leaderboard').insertOne({ finishedAt: new Date(), rule, results })
      .catch(err => console.error('[排行榜寫入失敗]', err.message));
  });

  // 查詢歷史排行榜：依「贏的次數」排名彙總（累計所有場次）
  socket.on('get_leaderboard', (data, callback) => {
    if (!dbReady) return callback && callback({ ok:false, error:'排行榜功能目前未啟用（尚未設定資料庫）' });
    db.collection('leaderboard').find({}).sort({ finishedAt:-1 }).limit(200).toArray()
      .then(docs => {
        const tally = {}; // name -> {wins, games}
        docs.forEach(d => (d.results||[]).forEach(r => {
          if (!tally[r.name]) tally[r.name] = { name:r.name, wins:0, games:0 };
          tally[r.name].games += 1;
          if (r.won) tally[r.name].wins += 1;
        }));
        const ranking = Object.values(tally).sort((a,b) => b.wins - a.wins || b.games - a.games);
        callback && callback({ ok:true, ranking, recentGames: docs.slice(0,20).map(d=>({ finishedAt:d.finishedAt, rule:d.rule, results:d.results })) });
      })
      .catch(err => callback && callback({ ok:false, error:err.message }));
  });

});

server.listen(PORT, () => {
  console.log(`伺服器啟動，監聽 port ${PORT}`);
});

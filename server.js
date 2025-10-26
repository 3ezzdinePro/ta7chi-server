const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 4000;
const app = express();
app.use(cors());
app.get('/', (req, res) => res.send('Ta7chi Fih server is running'));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' },
  pingTimeout: 60000
});

const SUITS = ['♠','♥','♦','♣'];
const RANKS = ['A','J','Q','K'];

function makeDeck() {
  const deck = [];
  for (const s of SUITS) for (const r of RANKS) deck.push({ rank: r, suit: s, id: `${r}${s}${Math.random().toString(36).slice(2,9)}` });
  return deck;
}
function shuffle(a){ for(let i=a.length-1;i>0;i--){const j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]];} return a; }

const rooms = {};

function broadcastRoomState(roomId){
  const r = rooms[roomId]; if(!r) return;
  const safePlayers = r.players.map(p => ({ id: p.id, name: p.name, count: p.hand.length, isHost: p.isHost || false }));
  const payload = { players: safePlayers, pileCount: r.pile.length, lastClaim: r.lastClaim, turnIndex: r.turnIndex, started: r.started };
  io.to(roomId).emit('room_state', payload);
  for(const p of r.players){ const sock = io.sockets.sockets.get(p.socketId); if(sock) sock.emit('your_hand', p.hand); }
}

function createRoom(roomId, hostPlayer){ rooms[roomId] = { players: [hostPlayer], pile: [], lastClaim: null, turnIndex: 0, started: false }; }

function dealCards(room){ const deck = shuffle(makeDeck()); const count = room.players.length; while(deck.length){ for(let i=0;i<count && deck.length;i++){ room.players[i].hand.push(deck.pop()); } } }

function removePlayerFromRoom(roomId, socketId){ const r = rooms[roomId]; if(!r) return; r.players = r.players.filter(p => p.socketId !== socketId); if(r.players.length === 0) delete rooms[roomId]; }
// Helper: advance to next active player
function nextTurn(room) {
  const len = room.players.length;
  if(room.players.every(p => p.finished)) return; // no one left
  let idx = room.turnIndex;
  for(let i=0; i<len; i++) {
    idx = (idx + 1) % len;
    if(!room.players[idx].finished) break;
  }
  room.turnIndex = idx;
}

// Helper: check if only one active player remains
function checkLastPlayer(room, roomId) {
  const active = room.players.filter(p => !p.finished);
  if(active.length === 1) {
    const loser = active[0];
    io.to(roomId).emit('game_over', { loserId: loser.id, loserName: loser.name, message: 'YOU WERE THE LEAST 7ACHWEJI' });
    room.started = false;
  }
}

function resolveCall(room, callerIndex, claimedIndex) {
  const last = room.lastClaim;
  if (!last) return null;

  const count = last.count || 0;
  // Only the cards involved in the last claim
  const revealed = room.pile.slice(-count);

  // Check if bluff
  const liar = revealed.some(c => last.rank ? (c.rank !== last.rank) : false);

  if (liar) {
    // Claimed player lied → they pick up only last claim cards
    room.players[claimedIndex].hand = room.players[claimedIndex].hand.concat(revealed);
    room.pile.splice(-count, count); // remove only these cards
    room.lastClaim = null;
    room.turnIndex = claimedIndex;
    return { result: 'liar', who: room.players[claimedIndex].id, picked: revealed.length };
  } else {
    // Caller was wrong → they pick up only last claim cards
    room.players[callerIndex].hand = room.players[callerIndex].hand.concat(revealed);
    room.pile.splice(-count, count); // remove only these cards
    room.lastClaim = null;
    room.turnIndex = callerIndex;
    return { result: 'wrong', who: room.players[callerIndex].id, picked: revealed.length };
  }
}


io.on('connection', socket => {
  socket.on('create_room', ({ roomId, name }, cb) => {
    if (!roomId) roomId = Math.random().toString(36).slice(2,8);
    if (rooms[roomId]) return cb && cb({ ok: false, error: 'Room exists' });
    const player = { id: 'p_' + socket.id.slice(0,6), socketId: socket.id, name: name || 'Guest', hand: [], isHost:true };
    createRoom(roomId, player);
    socket.join(roomId);
    broadcastRoomState(roomId);
    cb && cb({ ok: true, roomId, playerId: player.id });
  });

  socket.on('join_room', ({ roomId, name }, cb) => {
    const r = rooms[roomId]; 
    if (!r) return cb && cb({ ok: false, error: 'No such room' });
    if (r.started) return cb && cb({ ok: false, error: 'Game already started' });

    // Prevent the same socket from joining twice
    if (r.players.find(p => p.socketId === socket.id)) {
        return cb && cb({ ok: false, error: 'Already joined' });
    }

    const player = { id: 'p_' + socket.id.slice(0,6), socketId: socket.id, name: name || 'Guest', hand: [] };
    r.players.push(player);
    socket.join(roomId);
    broadcastRoomState(roomId);
    cb && cb({ ok: true, roomId, playerId: player.id });
});


  socket.on('start_game', ({ roomId }, cb) => {
    const r = rooms[roomId]; if(!r) return cb && cb({ ok: false, error: 'No such room' }); if(r.started) return cb && cb({ ok: false, error: 'Already started' });
    r.started = true; r.turnIndex = 0; r.pile = []; r.lastClaim = null; r.players.forEach(p => p.hand = []); dealCards(r); broadcastRoomState(roomId); cb && cb({ ok: true });
  });

  socket.on('play_cards', ({ roomId, playerId, cardIds, claim }) => {
  const r = rooms[roomId]; 
  if(!r || !r.started) return; 

  const idx = r.players.findIndex(p => p.id === playerId); 
  if(idx !== r.turnIndex) return; 

  const player = r.players[idx]; 
  const played = [];

  for(const cid of cardIds){ 
    const i = player.hand.findIndex(c => c.id === cid); 
    if(i !== -1) played.push(player.hand.splice(i,1)[0]); 
  }

  r.pile = r.pile.concat(played);
  r.lastClaim = { playerId, claimText: claim.claimText || `${played.length} x ${claim.rank||'?'}`, count: played.length, rank: claim.rank || null };

  // Mark player as finished if hand is empty
  if(player.hand.length === 0) player.finished = true;

  nextTurn(r, roomId);
  broadcastRoomState(roomId);

});


  socket.on('call_bluff', ({ roomId, callerId, claimedPlayerId }, cb) => {
  const r = rooms[roomId]; 
  if(!r || !r.started || !r.lastClaim) return cb && cb({ ok: false, error: 'Nothing to call' });

  const callerIdx = r.players.findIndex(p => p.id === callerId); 
  const claimedIdx = r.players.findIndex(p => p.id === claimedPlayerId);
  if(callerIdx === -1 || claimedIdx === -1) return cb && cb({ ok: false, error: 'Invalid players' });

  const res = resolveCall(r, callerIdx, claimedIdx);

  // After picking cards, mark as not finished if hand > 0
  if(r.players[claimedIdx].hand.length > 0) r.players[claimedIdx].finished = false;
  if(r.players[callerIdx].hand.length > 0) r.players[callerIdx].finished = false;

  nextTurn(r, roomId);
  broadcastRoomState(roomId);
  

  cb && cb({ ok: true, result: res });
});


  socket.on('leave_room', ({ roomId }) => { removePlayerFromRoom(roomId, socket.id); socket.leave(roomId); if(rooms[roomId]) broadcastRoomState(roomId); });

  socket.on('disconnecting', () => { const joined = Array.from(socket.rooms).filter(r => r !== socket.id); for(const roomId of joined){ removePlayerFromRoom(roomId, socket.id); if(rooms[roomId]) broadcastRoomState(roomId); } });
});

server.listen(PORT, () => { console.log(`Ta7chi server listening on ${PORT}`); });

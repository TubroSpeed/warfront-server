const { createServer } = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;

const httpServer = createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('WARFRONT.IO Relay Server is running!\n');
});

const io = new Server(httpServer, {
  cors: { origin: '*', methods: ['GET', 'POST'] }
});

const lobbies = {};

function makeCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  c += '-';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function getLobbyBySocket(socketId) {
  return Object.values(lobbies).find(l => l.players.some(p => p.id === socketId));
}

function broadcastLobbyUpdate(lobby) {
  lobby.players.forEach(p => {
    io.to(p.id).emit('lobby_update', {
      code: lobby.code,
      mode: lobby.mode,
      map: lobby.map,
      privacy: lobby.privacy,
      players: lobby.players.map(q => ({
        id: q.id,
        name: q.name,
        team: q.team,
        isHost: q.isHost,
      })),
    });
  });
}

io.on('connection', (socket) => {
  console.log('Player connected:', socket.id);

  socket.on('ping_check', (cb) => {
    if (typeof cb === 'function') cb();
    else socket.emit('pong_ms', 0);
  });

  socket.on('create_lobby', (data) => {
    const existing = getLobbyBySocket(socket.id);
    if (existing) leaveLobby(socket, existing);

    let code;
    do { code = makeCode(); } while (lobbies[code]);

    const lobby = {
      code,
      mode: data.mode || 'tdm',
      map: data.map || 'base',
      privacy: data.privacy || 'private',
      players: [{ id: socket.id, name: data.name || 'Player', team: 'a', isHost: true }],
      started: false,
    };
    lobbies[code] = lobby;
    socket.join(code);

    socket.emit('lobby_created', {
      code,
      playerId: socket.id,
      players: lobby.players,
      mode: lobby.mode,
      map: lobby.map,
    });
  });

  socket.on('join_lobby', (data) => {
    const code = (data.code || '').toUpperCase().trim();
    const lobby = lobbies[code];

    if (!lobby) { socket.emit('lobby_join_error', { message: `No lobby found with code ${code}` }); return; }
    if (lobby.started) { socket.emit('lobby_join_error', { message: 'Match already started' }); return; }
    if (lobby.players.length >= 8) { socket.emit('lobby_join_error', { message: 'Lobby is full' }); return; }

    const existing = getLobbyBySocket(socket.id);
    if (existing) leaveLobby(socket, existing);

    const teamA = lobby.players.filter(p => p.team === 'a').length;
    const teamB = lobby.players.filter(p => p.team === 'b').length;
    const team = teamA <= teamB ? 'a' : 'b';

    lobby.players.push({ id: socket.id, name: data.name || 'Player', team, isHost: false });
    socket.join(code);

    socket.emit('lobby_joined', {
      code,
      playerId: socket.id,
      players: lobby.players,
      mode: lobby.mode,
      map: lobby.map,
    });

    broadcastLobbyUpdate(lobby);
  });

  socket.on('list_public_lobbies', (cb) => {
    const list = Object.values(lobbies)
      .filter(l => l.privacy === 'public' && !l.started)
      .map(l => ({ code: l.code, mode: l.mode, map: l.map, playerCount: l.players.length }));
    if (typeof cb === 'function') cb(list);
  });

  socket.on('leave_lobby', () => {
    const lobby = getLobbyBySocket(socket.id);
    if (lobby) leaveLobby(socket, lobby);
  });

  socket.on('start_match', () => {
    const lobby = getLobbyBySocket(socket.id);
    if (!lobby) return;
    const player = lobby.players.find(p => p.id === socket.id);
    if (!player || !player.isHost) return;
    lobby.started = true;
    io.to(lobby.code).emit('match_starting', {
      mode: lobby.mode,
      map: lobby.map,
      players: lobby.players,
    });
  });

  socket.on('player_state', (data) => {
    const lobby = getLobbyBySocket(socket.id);
    if (!lobby) return;
    socket.to(lobby.code).emit('player_state', { ...data, id: socket.id });
  });

  socket.on('disconnect', () => {
    const lobby = getLobbyBySocket(socket.id);
    if (lobby) leaveLobby(socket, lobby);
  });
});

function leaveLobby(socket, lobby) {
  lobby.players = lobby.players.filter(p => p.id !== socket.id);
  socket.leave(lobby.code);

  if (lobby.players.length === 0) {
    delete lobbies[lobby.code];
    return;
  }

  if (!lobby.players.some(p => p.isHost)) {
    lobby.players[0].isHost = true;
  }

  io.to(lobby.code).emit('player_left', socket.id);
  broadcastLobbyUpdate(lobby);
}

httpServer.listen(PORT, () => {
  console.log(`WARFRONT.IO relay server running on port ${PORT}`);
});

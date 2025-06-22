const express = require('express');
const socketio = require('socket.io');
const http = require('http');

const app = express();
const server = http.createServer(app);
const io = socketio(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

const PORT = process.env.PORT || 3000;

// Baza słów
const words = require('./words.js');
const allWords = [
    ...words.polishCelebrities, 
    ...words.worldCelebrities, 
    ...words.tvAndMovieCharacters
];

const rooms = {};
let turnTimers = {};

app.use(express.static('public'));

app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

io.on('connection', (socket) => {
  console.log('New user connected:', socket.id);

  socket.on('createRoom', (data) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: {},
      gameState: 'waiting', // waiting, picking, playing, finished
      pairs: {},
      wordsToSubmit: 0,
      currentTurn: null,
      turnOrder: [],
    };
    socket.join(roomId);

    rooms[roomId].players[socket.id] = {
      name: data.playerName,
      score: 0,
      currentWord: null,
      wordSubmitter: null,
    };

    socket.emit('roomCreated', { roomId });
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);
  });

  socket.on('joinRoom', (data) => {
    const room = rooms[data.roomId];
    if (room) {
      if (room.gameState !== 'waiting') {
        return socket.emit('joinError', { message: 'Game has already started.' });
      }
      socket.join(data.roomId);
      room.players[socket.id] = {
        name: data.playerName,
        score: 0,
        currentWord: null,
        wordSubmitter: null,
      };
      socket.emit('joinedRoom', { success: true, roomId: data.roomId });
      io.to(data.roomId).emit('updatePlayers', room.players);
    } else {
      socket.emit('joinError', { message: 'Room not found.' });
    }
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const playerIds = Object.keys(room.players);

    if (playerIds.length >= 2) {
      // Shuffle players for random pairing and turn order
      const shuffledPlayers = [...playerIds].sort(() => 0.5 - Math.random());
      
      // Pair players in a circle: p1->p2, p2->p3, ..., pN->p1
      for (let i = 0; i < shuffledPlayers.length; i++) {
        const currentPlayer = shuffledPlayers[i];
        const partner = shuffledPlayers[(i + 1) % shuffledPlayers.length];
        room.pairs[currentPlayer] = partner;
      }

      room.gameState = 'picking';
      room.wordsToSubmit = playerIds.length;
      room.turnOrder = shuffledPlayers;

      // Send each player 3 unique word choices for their partner
      playerIds.forEach(playerId => {
        const partnerId = room.pairs[playerId];
        const partnerName = room.players[partnerId].name;
        
        const choices = [];
        const usedIndices = new Set();
        while (choices.length < 3) {
            const randomIndex = Math.floor(Math.random() * allWords.length);
            if (!usedIndices.has(randomIndex)) {
                choices.push(allWords[randomIndex]);
                usedIndices.add(randomIndex);
            }
        }
        io.to(playerId).emit('pickingStarted', { partnerName, choices });
      });
    } else {
        socket.emit('gameError', { message: 'Not enough players to start.' });
    }
  });

  socket.on('submitWord', (data) => {
    const room = rooms[data.roomId];
    if (room && room.gameState === 'picking') {
      const partnerId = room.pairs[socket.id];
      if (partnerId && room.players[partnerId]) {
        room.players[partnerId].currentWord = data.word;
        room.players[partnerId].wordSubmitter = socket.id;
        room.wordsToSubmit--;

        socket.emit('wordSubmitted');

        if (room.wordsToSubmit === 0) {
          room.gameState = 'playing';
          io.to(data.roomId).emit('allWordsSubmitted');
          nextTurn(data.roomId);
        }
      }
    }
  });

  socket.on('skipTurn', (roomId) => {
    const room = rooms[roomId];
    if (room && room.currentTurn === socket.id) {
        io.to(roomId).emit('turnSkipped', { playerId: socket.id });
        nextTurn(roomId);
    }
  });

  socket.on('makeGuess', (data) => {
    const room = rooms[data.roomId];
    if (room && room.currentTurn === socket.id) {
      const player = room.players[socket.id];
      const isCorrect = data.guess.toLowerCase() === player.currentWord.toLowerCase();
      
      io.to(data.roomId).emit('guessMade', {
        playerId: socket.id,
        guess: data.guess,
        isCorrect: isCorrect
      });
      
      if (isCorrect) {
        player.score += 1;
        player.currentWord = null; // Word is guessed
        io.to(data.roomId).emit('updatePlayers', room.players);
        nextTurn(data.roomId);
      }
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomId in rooms) {
      const room = rooms[roomId];
      if (room.players[socket.id]) {
        // If game is in progress, handle it
        if (room.gameState !== 'waiting') {
            endGame(roomId, `Player ${room.players[socket.id].name} disconnected.`);
        }
        delete room.players[socket.id];
        io.to(roomId).emit('updatePlayers', room.players);
      }
    }
  });
});

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function checkAnswer(word, question) {
  const q = question.toLowerCase();
  const w = word.toLowerCase();
  if (q.includes("mężczyzna")) return w.includes("pan ") || !w.includes("pani ");
  if (q.includes("kobieta")) return w.includes("pani ") || word.includes("a ");
  if (q.includes("aktor")) return w.includes("aktor") || w.includes("aktorka");
  if (q.includes("sportowiec")) return w.includes("piłkarz") || w.includes("tenisist");
  return Math.random() > 0.5; // Fallback for simple answers
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  if (!room) return;

  // Clear previous timer
  if (turnTimers[roomId]) {
    clearTimeout(turnTimers[roomId]);
    delete turnTimers[roomId];
  }

  // Find the next player who still has a word to guess
  const activePlayers = room.turnOrder.filter(id => room.players[id] && room.players[id].currentWord);
  
  if (activePlayers.length === 0) {
    return endGame(roomId, "All words have been guessed!");
  }

  const currentTurnIndex = room.turnOrder.indexOf(room.currentTurn);
  let nextPlayerId = room.turnOrder[(currentTurnIndex + 1) % room.turnOrder.length];

  // Find the next player in order who is still active
  while(!activePlayers.includes(nextPlayerId)){
      const nextIndex = room.turnOrder.indexOf(nextPlayerId);
      nextPlayerId = room.turnOrder[(nextIndex + 1) % room.turnOrder.length];
      // safety break for infinite loop
      if (nextPlayerId === room.currentTurn) break;
  }

  room.currentTurn = nextPlayerId;
  io.to(roomId).emit('turnChanged', { currentTurn: room.currentTurn });

  // Set a 60-second timer for the new turn
  turnTimers[roomId] = setTimeout(() => {
    io.to(roomId).emit('turnEnded', { playerId: room.currentTurn });
    nextTurn(roomId);
  }, 60000);
}

function endGame(roomId, reason) {
    const room = rooms[roomId];
    if (!room) return;

    if (turnTimers[roomId]) {
        clearTimeout(turnTimers[roomId]);
        delete turnTimers[roomId];
    }

    room.gameState = 'finished';
    io.to(roomId).emit('gameFinished', { reason: reason, players: room.players });
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const words = require('./words');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

const PORT = process.env.PORT || 3000;

app.use(express.static('public'));

app.get('/health', (req, res) => {
    res.status(200).send('OK');
});

const rooms = {};
const turnTimers = {};

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('createRoom', ({ playerName }) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: {},
      gameState: 'waiting', // waiting, picking, playing, finished
      pairs: {},
      wordsToSubmit: 0,
      currentTurn: null,
      turnOrder: [],
      turnCount: 0,
    };
    socket.join(roomId);

    rooms[roomId].players[socket.id] = {
      name: playerName,
      score: 0,
      currentWord: null,
      isReady: false
    };

    socket.emit('roomCreated', { roomId });
    io.to(roomId).emit('updatePlayers', rooms[roomId].players);
  });

  socket.on('joinRoom', ({ playerName, roomId }) => {
    if (rooms[roomId]) {
      if (Object.keys(rooms[roomId].players).length >= 10) {
        socket.emit('joinError', { message: 'Pokój jest pełny.' });
        return;
      }
      if (rooms[roomId].gameState !== 'waiting') {
        socket.emit('joinError', { message: 'Gra już się rozpoczęła.' });
        return;
      }

      socket.join(roomId);
      rooms[roomId].players[socket.id] = {
        name: playerName,
        score: 0,
        currentWord: null,
        isReady: false
      };
      socket.emit('joinedRoom', { success: true, roomId });
      io.to(roomId).emit('updatePlayers', rooms[roomId].players);
    } else {
      socket.emit('joinError', { message: 'Pokój nie istnieje.' });
    }
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    if (!room) return;
    const playerIds = Object.keys(room.players);
    if (playerIds.length < 2) {
        socket.emit('gameError', { message: 'Potrzeba co najmniej 2 graczy, aby rozpocząć grę.' });
        return;
    }

    room.gameState = 'picking';
    room.turnOrder = playerIds.sort(() => Math.random() - 0.5);
    
    // Create pairs for word picking
    for (let i = 0; i < room.turnOrder.length; i++) {
        const pickerId = room.turnOrder[i];
        const partnerId = room.turnOrder[(i + 1) % room.turnOrder.length];
        room.pairs[pickerId] = partnerId;
    }

    room.wordsToSubmit = playerIds.length;

    // Combine all word categories
    const allWords = [
        ...words.polishCelebrities,
        ...words.worldCelebrities,
        ...words.tvAndMovieCharacters,
        ...words.everydayItems,
        ...words.gameItemsAndCharacters
    ];

    // Send word choices to each player
    playerIds.forEach(playerId => {
        const partnerId = room.pairs[playerId];
        const partnerName = room.players[partnerId].name;
        
        // Get 5 unique random words
        const shuffled = [...allWords].sort(() => 0.5 - Math.random());
        const wordChoices = shuffled.slice(0, 5);
        
        // We send the full word object to the client now
        io.to(playerId).emit('pickingStarted', { 
            partnerName: partnerName,
            choices: wordChoices.map(w => w.word) // Only send the word string for selection
        });
    });
  });

  socket.on('submitWord', ({ roomId, word }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'picking') return;

    const pickerId = socket.id;
    const partnerId = room.pairs[pickerId];

    // Find the full word object from the original list
    const allWords = [
        ...words.polishCelebrities,
        ...words.worldCelebrities,
        ...words.tvAndMovieCharacters,
        ...words.everydayItems,
        ...words.gameItemsAndCharacters
    ];
    const chosenWordObject = allWords.find(w => w.word === word);

    if (chosenWordObject) {
        room.players[partnerId].currentWord = chosenWordObject; // Store the full object
        room.wordsToSubmit--;
        socket.emit('wordSubmitted');

        if (room.wordsToSubmit === 0) {
            room.gameState = 'playing';
            io.to(roomId).emit('allWordsSubmitted');
            io.to(roomId).emit('updatePlayers', room.players); // Send words to all players
            nextTurn(roomId);
        }
    }
  });

  socket.on('makeGuess', ({ roomId, guess }) => {
    const room = rooms[roomId];
    if (!room || room.currentTurn !== socket.id) return;

    const guesserId = socket.id;
    const correctWord = room.players[guesserId].currentWord.word;
    const isCorrect = guess.trim().toLowerCase() === correctWord.toLowerCase();

    if (isCorrect) {
        room.players[guesserId].score++;
        io.to(roomId).emit('updatePlayers', room.players);
        io.to(roomId).emit('guessMade', { playerId: guesserId, guess, isCorrect });
        nextTurn(roomId);
    } else {
        io.to(roomId).emit('guessMade', { playerId: guesserId, guess, isCorrect });
    }
  });

  socket.on('skipTurn', (roomId) => {
    if (rooms[roomId] && rooms[roomId].currentTurn === socket.id) {
        io.to(roomId).emit('turnSkipped', { playerId: socket.id });
        nextTurn(roomId);
    }
  });

  socket.on('getHint', (roomId) => {
    const room = rooms[roomId];
    if (!room || room.turnCount < 10) return;

    const currentPlayerId = room.currentTurn;
    const currentWordObject = room.players[currentPlayerId]?.currentWord;

    if (currentWordObject && currentWordObject.hint) {
      const hint = currentWordObject.hint;
      io.to(roomId).emit('hint', { hint });
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomId in rooms) {
      if (rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];
        if (Object.keys(rooms[roomId].players).length === 0) {
          delete rooms[roomId];
          if (turnTimers[roomId]) {
            clearTimeout(turnTimers[roomId]);
            delete turnTimers[roomId];
          }
          console.log(`Room ${roomId} deleted.`);
        } else {
          io.to(roomId).emit('updatePlayers', rooms[roomId].players);
        }
        break;
      }
    }
  });
});

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.turnCount++;

    // Clear any existing timer for the previous turn
    if (turnTimers[roomId]) {
        clearTimeout(turnTimers[roomId]);
        delete turnTimers[roomId];
    }

    const currentTurnIndex = room.turnOrder.indexOf(room.currentTurn);
    const nextPlayerIndex = (currentTurnIndex + 1) % room.turnOrder.length;
    const nextPlayerId = room.turnOrder[nextPlayerIndex];

    room.currentTurn = nextPlayerId;
    // Announce the turn change to everyone
    io.to(roomId).emit('turnChanged', { 
        currentTurn: room.currentTurn,
        turnCount: room.turnCount
    });

    // Set a timer for the new turn
    turnTimers[roomId] = setTimeout(() => {
        io.to(roomId).emit('turnEnded', { playerId: room.currentTurn });
        nextTurn(roomId);
    }, 45000); // 45 seconds
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
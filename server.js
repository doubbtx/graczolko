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
      isReady: false,
      hasGuessed: false,
      skipCount: 0
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
        isReady: false,
        hasGuessed: false,
        skipCount: 0
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
    if (Object.keys(room.players).length < 2) {
        socket.emit('gameError', { message: 'Potrzeba co najmniej 2 graczy, aby rozpocząć grę.' });
        return;
    }
    startPickingPhase(roomId);
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

  socket.on('submitCustomWord', ({ roomId, customWord }) => {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'picking' || !customWord) return;

    const pickerId = socket.id;
    const partnerId = room.pairs[pickerId];

    // Create a word object for the custom word
    const customWordObject = { word: customWord.trim(), hint: 'Słowo niestandardowe' };

    if(customWordObject.word.length > 0) {
        room.players[partnerId].currentWord = customWordObject;
        room.wordsToSubmit--;
        socket.emit('wordSubmitted');

        if (room.wordsToSubmit === 0) {
            room.gameState = 'playing';
            io.to(roomId).emit('allWordsSubmitted');
            io.to(roomId).emit('updatePlayers', room.players);
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

    io.to(roomId).emit('guessMade', { playerId: guesserId, guess, isCorrect });

    if (isCorrect) {
        room.players[guesserId].score++;
        room.players[guesserId].hasGuessed = true;
        io.to(roomId).emit('updatePlayers', room.players);

        const allGuessed = Object.values(room.players).every(p => p.hasGuessed);
        if (allGuessed) {
            io.to(roomId).emit('roundFinished');

            if (turnTimers[roomId]) {
                clearTimeout(turnTimers[roomId]);
                delete turnTimers[roomId];
            }

            // Wait 5 seconds before starting the next round
            setTimeout(() => {
                room.wordsToSubmit = 0;
                room.turnCount = 0;
                room.gameState = 'picking';
                for (const playerId in room.players) {
                    const player = room.players[playerId];
                    player.hasGuessed = false;
                    player.currentWord = null;
                    player.skipCount = 0; // Reset skip count for the new round
                }
                io.to(roomId).emit('updatePlayers', room.players); // Send cleared state to sidebar
                
                // Start the next round's picking phase
                startPickingPhase(roomId);
            }, 5000); // 5-second delay

        } else {
            nextTurn(roomId);
        }
    }
  });

  socket.on('skipTurn', (roomId) => {
    const room = rooms[roomId];
    if (room && room.currentTurn === socket.id) {
        const player = room.players[socket.id];
        if (player) {
            player.skipCount++;
            io.to(roomId).emit('updatePlayers', room.players);
        }
        io.to(roomId).emit('turnSkipped', { playerId: socket.id });
        nextTurn(roomId);
    }
  });

  socket.on('getHint', (roomId) => {
    const room = rooms[roomId];
    const player = room?.players[socket.id];
    // Only the current player can request a hint for their own word, after 12 skips.
    if (!room || !player || room.currentTurn !== socket.id || player.skipCount < 12) return;

    const currentWordObject = player.currentWord;

    if (currentWordObject && currentWordObject.hint) {
      const hint = currentWordObject.hint;
      socket.emit('hint', { hint }); // Send hint only to the requester
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    for (const roomId in rooms) {
      if (rooms[roomId].players[socket.id]) {
        const room = rooms[roomId];
        const wasCurrentTurn = room.currentTurn === socket.id;
        
        delete room.players[socket.id];

        // Check if the game should be aborted
        if (Object.keys(room.players).length < 2 && room.gameState !== 'waiting') {
            io.to(roomId).emit('gameAborted', 'Za mało graczy, aby kontynuować. Gra została zakończona.');
            if (turnTimers[roomId]) clearTimeout(turnTimers[roomId]);
            delete rooms[roomId];
            console.log(`Room ${roomId} deleted due to lack of players.`);
        } else {
            // If the game continues, update players and handle turn change
            io.to(roomId).emit('updatePlayers', room.players);
            if (room.gameState === 'playing' && wasCurrentTurn) {
                nextTurn(roomId);
            }
        }
        break; // Found the room, exit the loop
      }
    }
  });
});

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function startPickingPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;

    room.gameState = 'picking';
    room.turnOrder = Object.keys(room.players).sort(() => Math.random() - 0.5);
    
    // Create pairs for word picking
    for (let i = 0; i < room.turnOrder.length; i++) {
        const pickerId = room.turnOrder[i];
        const partnerId = room.turnOrder[(i + 1) % room.turnOrder.length];
        room.pairs[pickerId] = partnerId;
    }

    room.wordsToSubmit = room.turnOrder.length;

    // Combine all word categories
    const allWords = [
        ...words.polishCelebrities,
        ...words.worldCelebrities,
        ...words.tvAndMovieCharacters,
        ...words.everydayItems,
        ...words.gameItemsAndCharacters
    ];

    // Send word choices to each player
    room.turnOrder.forEach(playerId => {
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
}

function nextTurn(roomId) {
    const room = rooms[roomId];
    if (!room || room.gameState !== 'playing') return;

    // Clear any existing timer
    if (turnTimers[roomId]) {
        clearTimeout(turnTimers[roomId]);
        delete turnTimers[roomId];
    }

    // Find players who haven't guessed yet
    const activePlayers = room.turnOrder.filter(id => room.players[id] && !room.players[id].hasGuessed);
    if (activePlayers.length === 0) {
        // This case is handled by the allGuessed check in makeGuess, but it's a safe fallback.
        return; 
    }

    room.turnCount++;

    // Find the index of the last player in the original turn order
    const lastTurnIndex = room.currentTurn ? room.turnOrder.indexOf(room.currentTurn) : -1;
    
    let nextPlayerId = null;
    // Search for the next active player in the turn order, starting from the player after the current one.
    if (lastTurnIndex !== -1) {
        for (let i = 1; i <= room.turnOrder.length; i++) {
            const nextIndex = (lastTurnIndex + i) % room.turnOrder.length;
            const potentialNextPlayerId = room.turnOrder[nextIndex];
            if (activePlayers.includes(potentialNextPlayerId)) {
                nextPlayerId = potentialNextPlayerId;
                break;
            }
        }
    }

    // If no player had a turn yet, or if the last player left, pick the first active one.
    if (!nextPlayerId) {
        nextPlayerId = activePlayers[0];
    }

    room.currentTurn = nextPlayerId;
    io.to(roomId).emit('turnChanged', { 
        currentTurn: room.currentTurn,
        turnCount: room.turnCount
    });

    turnTimers[roomId] = setTimeout(() => {
        io.to(roomId).emit('turnEnded', { playerId: room.currentTurn });
        nextTurn(roomId);
    }, 45000); // 45 seconds
}

server.listen(PORT, () => {
  console.log(`Server listening on port ${PORT}`);
});
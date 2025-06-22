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
const allWords = [
    // Polish
    "Robert Lewandowski", "Kuba Wojewódzki", "Małgorzata Rozenek", "Adam Małysz", "Marta Żmuda Trzebiatowska", "Borys Szyc",
    "Lech Wałęsa", "Jan Paweł II", "Mikołaj Kopernik", "Maria Skłodowska-Curie", "Fryderyk Chopin", "Andrzej Wajda",
    "Roman Polański", "Krzysztof Kieślowski", "Wisława Szymborska", "Olga Tokarczuk", "Czesław Miłosz", "Iga Świątek",
    // International
    "Robert Downey Jr.", "Taylor Swift", "Leonardo DiCaprio", "Beyoncé", "Tom Hanks", "Angelina Jolie", "Albert Einstein",
    "Marie Curie", "Nelson Mandela", "Mahatma Gandhi", "Martin Luther King Jr.", "Winston Churchill", "Queen Elizabeth II",
    "Barack Obama", "Donald Trump", "Elon Musk", "Jeff Bezos", "Bill Gates", "Steve Jobs", "Mark Zuckerberg", "Dwayne Johnson",
    "Cristiano Ronaldo", "Lionel Messi",
    // Characters
    "Walter White (Breaking Bad)", "Sheldon Cooper (The Big Bang Theory)", "Jon Snow (Game of Thrones)", "Hermione Granger (Harry Potter)",
    "Tony Soprano (The Sopranos)", "Michael Scott (The Office)", "Harry Potter", "Darth Vader", "Luke Skywalker", "Indiana Jones",
    "James Bond", "Sherlock Holmes", "Batman", "Superman", "Spider-Man", "Wonder Woman", "The Joker", "Gandalf", "Frodo Baggins",
    "Katniss Everdeen (The Hunger Games)", "Forrest Gump", "Jack Sparrow (Pirates of the Caribbean)", "Rocky Balboa"
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

    // Add creator as the first player
    rooms[roomId].players[socket.id] = {
      name: data.playerName,
      score: 0,
      currentWord: null,
      wordSubmitter: null,
      notes: ""
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
        notes: ""
      };
      socket.emit('joinedRoom', { success: true, roomId: data.roomId });
      io.to(data.roomId).emit('updatePlayers', room.players);
    } else {
      socket.emit('joinError', { message: 'Room not found.' });
    }
  });

  socket.on('startGame', (roomId) => {
    const room = rooms[roomId];
    const playerIds = Object.keys(room.players);
    if (room && playerIds.length >= 2) {
      // Pair players up
      for (let i = 0; i < playerIds.length; i += 2) {
        if (playerIds[i + 1]) {
          room.pairs[playerIds[i]] = playerIds[i + 1];
          room.pairs[playerIds[i + 1]] = playerIds[i];
        } else {
          // Odd player out, pair with the first player
          room.pairs[playerIds[i]] = playerIds[0];
          room.pairs[playerIds[0]] = playerIds[i];
        }
      }

      room.gameState = 'picking';
      room.wordsToSubmit = playerIds.length;
      room.turnOrder = playerIds;

      io.to(roomId).emit('pickingStarted', { pairs: room.pairs });
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

        // Tell submitter their word was received
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

  socket.on('askQuestion', (data) => {
    const room = rooms[data.roomId];
    if (room && room.currentTurn === socket.id) {
      const player = room.players[socket.id];
      // The player who chose the word must answer.
      const answerer = room.players[player.wordSubmitter];
      io.to(data.roomId).emit('questionAsked', {
        questioner: socket.id,
        question: data.question,
        answer: checkAnswer(player.currentWord, data.question)
      });
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
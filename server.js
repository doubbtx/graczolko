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
const words = {
  polish: [
    "Robert Lewandowski", "Kuba Wojewódzki", "Małgorzata Rozenek",
    "Adam Małysz", "Marta Żmuda Trzebiatowska", "Borys Szyc"
  ],
  international: [
    "Robert Downey Jr.", "Taylor Swift", "Leonardo DiCaprio",
    "Beyoncé", "Tom Hanks", "Angelina Jolie"
  ],
  characters: [
    "Walter White (Breaking Bad)", "Sheldon Cooper (The Big Bang Theory)",
    "Jon Snow (Game of Thrones)", "Hermione Granger (Harry Potter)",
    "Tony Soprano (The Sopranos)", "Michael Scott (The Office)"
  ]
};

const rooms = {};

app.use(express.static('public'));

// Healthcheck endpoint for Railway
app.get('/health', (req, res) => {
  res.status(200).send('OK');
});

io.on('connection', (socket) => {
  console.log('New user connected');

  socket.on('createRoom', (data) => {
    const roomId = generateRoomId();
    rooms[roomId] = {
      players: {},
      gameState: 'waiting',
      currentTurn: null,
      words: [...words[data.category]],
      usedWords: []
    };
    socket.join(roomId);
    socket.emit('roomCreated', { roomId });
  });

  socket.on('joinRoom', (data) => {
    if (rooms[data.roomId]) {
      socket.join(data.roomId);
      rooms[data.roomId].players[socket.id] = {
        name: data.playerName,
        score: 0,
        currentWord: null,
        notes: ""
      };
      socket.emit('joinedRoom', { success: true });
      io.to(data.roomId).emit('updatePlayers', rooms[data.roomId].players);
    } else {
      socket.emit('joinedRoom', { success: false });
    }
  });

  socket.on('startGame', (roomId) => {
    if (rooms[roomId]) {
      rooms[roomId].gameState = 'playing';
      assignWords(roomId);
      rooms[roomId].currentTurn = Object.keys(rooms[roomId].players)[0];
      io.to(roomId).emit('gameStarted', { 
        currentTurn: rooms[roomId].currentTurn,
        yourWord: rooms[roomId].players[socket.id].currentWord
      });
    }
  });

  socket.on('askQuestion', (data) => {
    const room = rooms[data.roomId];
    if (room && room.currentTurn === socket.id) {
      io.to(data.roomId).emit('questionAsked', {
        playerId: socket.id,
        question: data.question,
        answer: checkAnswer(room.players[socket.id].currentWord, data.question)
      });
      nextTurn(data.roomId);
    }
  });

  socket.on('makeGuess', (data) => {
    const room = rooms[data.roomId];
    if (room && room.players[socket.id]) {
      const isCorrect = data.guess.toLowerCase() === room.players[socket.id].currentWord.toLowerCase();
      io.to(data.roomId).emit('guessMade', {
        playerId: socket.id,
        guess: data.guess,
        isCorrect: isCorrect
      });
      
      if (isCorrect) {
        room.players[socket.id].score += 1;
        assignNewWord(data.roomId, socket.id);
        io.to(data.roomId).emit('updatePlayers', room.players);
      }
    }
  });

  socket.on('updateNotes', (data) => {
    if (rooms[data.roomId] && rooms[data.roomId].players[socket.id]) {
      rooms[data.roomId].players[socket.id].notes = data.notes;
    }
  });

  socket.on('disconnect', () => {
    console.log('User disconnected');
    // Clean up disconnected players from all rooms
    for (const roomId in rooms) {
      if (rooms[roomId].players[socket.id]) {
        delete rooms[roomId].players[socket.id];
        io.to(roomId).emit('updatePlayers', rooms[roomId].players);
      }
    }
  });
});

function generateRoomId() {
  return Math.random().toString(36).substr(2, 6).toUpperCase();
}

function assignWords(roomId) {
  const room = rooms[roomId];
  const availableWords = [...room.words];
  
  Object.keys(room.players).forEach(playerId => {
    if (availableWords.length === 0) {
      availableWords.push(...room.usedWords);
      room.usedWords = [];
    }
    const randomIndex = Math.floor(Math.random() * availableWords.length);
    room.players[playerId].currentWord = availableWords[randomIndex];
    room.usedWords.push(availableWords[randomIndex]);
    availableWords.splice(randomIndex, 1);
  });
}

function assignNewWord(roomId, playerId) {
  const room = rooms[roomId];
  if (room.words.length === 0) {
    room.words.push(...room.usedWords);
    room.usedWords = [];
  }
  const randomIndex = Math.floor(Math.random() * room.words.length);
  room.players[playerId].currentWord = room.words[randomIndex];
  room.usedWords.push(room.words[randomIndex]);
  room.words.splice(randomIndex, 1);
}

function checkAnswer(word, question) {
  // Prosta logika sprawdzania odpowiedzi
  const q = question.toLowerCase();
  const w = word.toLowerCase();
  
  if (q.includes("mężczyzna")) return w.includes("pan ") || !w.includes("pani ");
  if (q.includes("kobieta")) return w.includes("pani ") || word.includes("a ");
  if (q.includes("aktor")) return w.includes("aktor") || w.includes("aktorka");
  if (q.includes("sportowiec")) return w.includes("piłkarz") || w.includes("tenisist");
  
  // Domyślnie losowa odpowiedź
  return Math.random() > 0.5;
}

function nextTurn(roomId) {
  const room = rooms[roomId];
  const playerIds = Object.keys(room.players);
  const currentIndex = playerIds.indexOf(room.currentTurn);
  room.currentTurn = playerIds[(currentIndex + 1) % playerIds.length];
  io.to(roomId).emit('turnChanged', { currentTurn: room.currentTurn });
}

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const { generateGamePin, generateTargetNumbers } = require('./utils');

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Serve static files
app.use(express.static(path.join(__dirname)));

// Debug endpoint to check game state
app.get('/api/game/:pin', (req, res) => {
  const gamePin = req.params.pin;
  
  if (!games[gamePin]) {
    return res.status(404).json({ error: 'Game not found' });
  }
  
  // Return safe version of game state (without socket IDs)
  const game = games[gamePin];
  const safeGame = {
    pin: game.pin,
    playerCount: game.playerCount,
    status: game.status,
    currentRound: game.currentRound,
    timeLeft: game.timeLeft,
    targetNumbers: game.targetNumbers,
    players: Object.values(game.players).map(p => ({
      nickname: p.nickname,
      ready: p.ready
    }))
  };
  
  res.json(safeGame);
});

// Game state
const games = {};
const ROUND_DURATION = 60; // seconds per round
const TOTAL_ROUNDS = 4;

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log('New client connected:', socket.id);

  // Teacher creates a new game
  socket.on('teacher:create_game', (teacherData) => {
    const gamePin = generateGamePin();
    const { email } = teacherData;
    
    games[gamePin] = {
      pin: gamePin,
      teacherId: socket.id,
      teacherEmail: email, // Store teacher email for authentication
      teacherConnected: true, // Flag to track teacher connection status
      players: {},
      playerCount: 0,
      status: 'waiting', // waiting, active, completed
      currentRound: 1,
      timeLeft: ROUND_DURATION,
      targetNumbers: generateTargetNumbers(TOTAL_ROUNDS),
      gameStats: {},
      timerInterval: null
    };
    
    // Join the game room
    socket.join(gamePin);
    console.log(`Teacher (${socket.id}) joined room: ${gamePin}`);
    
    // Send game pin back to teacher
    socket.emit('game:created', { gamePin });
    console.log(`Game created with PIN: ${gamePin}`);
    console.log(`Active games: ${Object.keys(games).join(', ')}`);
  });

  // Validate game pin
  socket.on('student:validate_game', (data) => {
    const { gamePin } = data;
    
    console.log(`Validating game pin: ${gamePin}`);
    console.log(`Available games: ${Object.keys(games).join(', ') || 'None'}`);
    
    if (!games[gamePin]) {
      console.log(`Game not found for pin: ${gamePin}`);
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    // Game exists, validate it
    socket.emit('game:validated', { gamePin });
    console.log(`Game pin ${gamePin} validated`);
  });

  // Teacher rejoins a game (when loading gamestart page)
  socket.on('teacher:rejoin_game', (data) => {
    const { gamePin, teacherEmail } = data;
    
    if (!games[gamePin]) {
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    // Verify teacher email if provided
    if (teacherEmail && game.teacherEmail && teacherEmail !== game.teacherEmail) {
      socket.emit('game:error', { message: 'Unauthorized access' });
      return;
    }
    
    // Update teacher ID in case they reconnected
    game.teacherId = socket.id;
    game.teacherConnected = true;
    
    // Join the game room
    socket.join(gamePin);
    console.log(`Teacher (${socket.id}) rejoined room: ${gamePin}`);
    
    // If game was paused because teacher disconnected, resume it
    if (game.status === 'paused' && !game.pausedByTeacher) {
      game.status = 'active';
      io.to(gamePin).emit('game:resumed', { timeLeft: game.timeLeft });
      startGameTimer(gamePin);
    }
    
    // Send current player list
    socket.emit('game:player_joined', {
      players: Object.values(game.players).map(p => ({
        nickname: p.nickname,
        ready: p.ready
      })),
      playerCount: game.playerCount
    });
  });

  // Teacher requests full game state
  socket.on('teacher:request_game_state', (data) => {
    const { gamePin } = data;
    
    if (!games[gamePin]) {
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    // Create player target mapping for the current round
    const playerTargets = {};
    if (game.playerIndex) {
      Object.keys(game.playerIndex).forEach(nickname => {
        const playerIndex = game.playerIndex[nickname];
        const currentRoundIndex = game.currentRound - 1;
        const targetIndex = (playerIndex + currentRoundIndex) % 4;
        const targetNumber = game.targetNumbers[targetIndex];
        playerTargets[nickname] = targetNumber;
      });
    }
    
    // Send complete game state to teacher
    socket.emit('game:state', {
      status: game.status,
      currentRound: game.currentRound,
      timeLeft: game.timeLeft,
      targetNumbers: game.targetNumbers,
      gameStats: game.gameStats,
      playerCount: game.playerCount,
      playerTargets: playerTargets, // Include player-specific target numbers
      players: Object.values(game.players).map(p => ({
        nickname: p.nickname,
        ready: p.ready
      }))
    });
    
    console.log(`Sent full game state to teacher for game ${gamePin}`);
  });

  // Student ensures they're in the game room (waiting for game to start)
  socket.on('student:ensure_in_room', (data) => {
    const { gamePin, nickname } = data;
    
    if (!games[gamePin]) {
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    // Join the game room
    socket.join(gamePin);
    console.log(`Student ${nickname} joined room ${gamePin} (waiting for game to start)`);
  });

  // Student rejoins a game (when loading game page)
  socket.on('student:rejoin_game', (data) => {
    const { gamePin, nickname } = data;
    
    console.log(`Student ${nickname} attempting to rejoin game ${gamePin}`);
    
    if (!games[gamePin]) {
      console.error(`Game not found for pin: ${gamePin} when student ${nickname} tried to rejoin`);
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    // Check if this player was already in the game
    const existingPlayerEntry = Object.entries(game.players).find(([_, player]) => player.nickname === nickname);
    
    // If player exists but with a different socket ID, update the socket ID
    if (existingPlayerEntry) {
      const oldSocketId = existingPlayerEntry[0];
      if (oldSocketId !== socket.id) {
        console.log(`Updating socket ID for player ${nickname} from ${oldSocketId} to ${socket.id}`);
        // Copy player data to new socket ID
        game.players[socket.id] = game.players[oldSocketId];
        game.players[socket.id].id = socket.id;
        // Remove old socket entry
        delete game.players[oldSocketId];
      }
    } else {
      // This is unusual - player not found but trying to rejoin
      console.warn(`Player ${nickname} trying to rejoin game ${gamePin} but not found in players list`);
      console.log(`Current players: ${Object.values(game.players).map(p => p.nickname).join(', ')}`);
      
      // Add them to the game if there's room
      if (Object.keys(game.players).length < 4) {
        console.log(`Adding player ${nickname} to game ${gamePin} during rejoin`);
        
        // Determine player index - try to restore original index or assign new one
        let newPlayerIndex;
        if (game.playerIndex && game.playerIndex[nickname] !== undefined) {
          // Use existing index if available
          newPlayerIndex = game.playerIndex[nickname];
          console.log(`Restored original index ${newPlayerIndex} for player ${nickname}`);
        } else {
          // Assign new index based on current player count
          newPlayerIndex = Object.keys(game.players).length;
          
          // Initialize playerIndex if needed
          if (!game.playerIndex) {
            game.playerIndex = {};
          }
          
          // Store the player index
          game.playerIndex[nickname] = newPlayerIndex;
          console.log(`Assigned new index ${newPlayerIndex} to player ${nickname}`);
        }
        
        game.players[socket.id] = {
          id: socket.id,
          nickname,
          ready: true,
          stats: Array(4).fill().map(() => ({
            correct: 0,
            incorrect: 0,
            duplicate: 0
          }))
        };
        
        // Initialize stats for this player
        game.gameStats[nickname] = Array(4).fill().map(() => ({
          correct: 0,
          incorrect: 0,
          duplicate: 0
        }));
      } else {
        console.error(`Cannot add player ${nickname} to game ${gamePin} - game is full`);
        socket.emit('game:error', { message: 'Game is full' });
        return;
      }
    }
    
    // Join the game room
    socket.join(gamePin);
    console.log(`Student ${nickname} (${socket.id}) rejoined room: ${gamePin}`);
    
    // If the game is already active, send the current state
    if (game.status === 'active') {
      socket.emit('game:time_update', {
        timeLeft: game.timeLeft,
        currentRound: game.currentRound
      });
    }
    
    // Always send current player list when a student rejoins
    const playerList = Object.values(game.players).map(p => ({
      nickname: p.nickname,
      ready: p.ready
    }));
    
    console.log(`Sending player list to ${nickname} with ${playerList.length} players: ${playerList.map(p => p.nickname).join(', ')}`);
    socket.emit('game:player_list', { players: playerList });
    
    // Send all previous equations to the rejoining player
    if (game.equations) {
      // For each player who has submitted equations
      Object.keys(game.equations).forEach(playerNickname => {
        // For each target number
        Object.keys(game.equations[playerNickname]).forEach(targetNumber => {
          const equations = game.equations[playerNickname][targetNumber];
          
          // For each equation submitted for this target
          equations.forEach(eq => {
            // Find player's index for consistent coloring
            const submittingPlayerIndex = game.playerIndex[playerNickname];
            
            // Send to the rejoining player
            socket.emit('player:correct_equation', {
              nickname: playerNickname,
              equation: eq.equation,
              targetNumber: parseInt(targetNumber),
              round: eq.round,
              playerIndex: submittingPlayerIndex || eq.playerIndex // Use stored index if available
            });
          });
        });
      });
    }
    
    // Send player-specific target number for the current round
    const playerIndex = game.playerIndex[nickname];
    if (playerIndex !== undefined) {
      // Calculate which target number this player should have for the current round
      const currentRoundIndex = game.currentRound - 1;
      const targetIndex = (playerIndex + currentRoundIndex) % 4;
      const targetNumber = game.targetNumbers[targetIndex];
      
      console.log(`Rejoining player ${nickname} (index ${playerIndex}): Sending target number ${targetNumber} (index ${targetIndex}) for round ${game.currentRound}`);
      
      // Send player-specific target number
      socket.emit('game:player_target', {
        targetNumber,
        playerIndex,
        currentRound: game.currentRound
      });
    } else {
      console.error(`Cannot send target number to player ${nickname}: No player index assigned`);
    }
  });
  
  // Student requests current players in the game
  socket.on('student:request_players', (data) => {
    const { gamePin } = data;
    
    console.log(`Received student:request_players for game ${gamePin} from socket ${socket.id}`);
    
    if (!games[gamePin]) {
      console.error(`Game not found for pin: ${gamePin}`);
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    // Check if the game has players
    if (!game.players || Object.keys(game.players).length === 0) {
      console.error(`No players found in game ${gamePin}`);
      // Send empty array but don't error
      socket.emit('game:player_list', { players: [] });
      return;
    }
    
    // Log player count for debugging
    console.log(`Sending player list for game ${gamePin}, player count: ${Object.keys(game.players).length}`);
    console.log(`Players: ${Object.values(game.players).map(p => p.nickname).join(', ')}`);

    // Send current player list to the student
    const playerList = Object.values(game.players).map(p => ({
      nickname: p.nickname,
      ready: p.ready
    }));
    
    console.log(`Emitting game:player_list with ${playerList.length} players to socket ${socket.id}`);
    socket.emit('game:player_list', { players: playerList });
    
    // Find the player's nickname from their socket ID
    const player = game.players[socket.id];
    if (player) {
      const nickname = player.nickname;
      const playerIndex = game.playerIndex[nickname];
      
      if (playerIndex !== undefined) {
        // Calculate which target number this player should have for the current round
        const currentRoundIndex = game.currentRound - 1;
        const targetIndex = (playerIndex + currentRoundIndex) % 4;
        const targetNumber = game.targetNumbers[targetIndex];
        
        console.log(`Player ${nickname} requested players: Sending target number ${targetNumber} (index ${targetIndex}) for round ${game.currentRound}`);
        
        // Send player-specific target number
        socket.emit('game:player_target', {
          targetNumber,
          playerIndex,
          currentRound: game.currentRound
        });
      }
    }
  });

  // Student joins a game
  socket.on('student:join_game', (data) => {
    const { gamePin, nickname } = data;
    
    if (!games[gamePin]) {
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    // Check if game is full
    if (Object.keys(game.players).length >= 4) {
      socket.emit('game:error', { message: 'Game is full' });
      return;
    }
    
    // Check if nickname is already taken
    const nicknameTaken = Object.values(game.players).some(player => player.nickname === nickname);
    if (nicknameTaken) {
      socket.emit('game:error', { message: 'Nickname already taken' });
      return;
    }
    
    // Add player to game
    game.players[socket.id] = {
      id: socket.id,
      nickname,
      ready: true,
      stats: Array(TOTAL_ROUNDS).fill().map(() => ({
        correct: 0,
        incorrect: 0,
        duplicate: 0
      }))
    };
    
    game.playerCount++;
    game.gameStats[nickname] = Array(TOTAL_ROUNDS).fill().map(() => ({
      correct: 0,
      incorrect: 0,
      duplicate: 0
    }));
    
    // Join the game room
    socket.join(gamePin);
    
    // Notify teacher of new player
    console.log(`Notifying teacher (${game.teacherId}) about new player: ${nickname}`);
    console.log(`Current players in game ${gamePin}: ${Object.values(game.players).map(p => p.nickname).join(', ')}`);
    
    // Send to specific teacher socket AND broadcast to the game room
    // This ensures all connected clients get the update
    io.in(gamePin).emit('game:player_joined', {
      players: Object.values(game.players).map(p => ({
        nickname: p.nickname,
        ready: p.ready
      })),
      playerCount: game.playerCount
    });
    
    // Confirm join to student
    socket.emit('game:joined', {
      gamePin,
      nickname
    });
    
    console.log(`Player ${nickname} joined game ${gamePin}`);
  });

  // Teacher starts the game
  socket.on('teacher:start_game', (data) => {
    const { gamePin } = data;
    
    if (!games[gamePin]) {
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    if (socket.id !== game.teacherId) {
      socket.emit('game:error', { message: 'Only the teacher can start the game' });
      return;
    }
    
    // Check if we have enough players (4 players required)
    if (game.playerCount < 4) {
      socket.emit('game:error', { message: 'Need 4 players to start the game' });
      return;
    }
    
    // Log all players before starting the game
    console.log(`Starting game ${gamePin} with ${game.playerCount} players:`);
    Object.values(game.players).forEach(player => {
      console.log(`- ${player.nickname} (${player.id})`);
    });
    
    game.status = 'active';
    game.timeLeft = ROUND_DURATION;
    game.currentRound = 1;
    
    // Notify all players that game is starting
    console.log(`Notifying all players in room ${gamePin} that game is starting`);
    
    // Get all sockets in the room
    const sockets = io.sockets.adapter.rooms.get(gamePin);
    if (sockets) {
      console.log(`Number of sockets in room ${gamePin}: ${sockets.size}`);
    } else {
      console.log(`No sockets found in room ${gamePin}`);
    }
    
    // Assign initial target numbers to players
    // Each player gets a different target number in round 1
    const playerArray = Object.values(game.players);
    
    // Create a playerIndex map to track player positions (0-3)
    game.playerIndex = {};
    playerArray.forEach((player, index) => {
      game.playerIndex[player.nickname] = index;
      console.log(`Assigned index ${index} to player ${player.nickname}`);
    });
    
    // Send game starting event to all players
    io.to(gamePin).emit('game:starting', {
      targetNumbers: game.targetNumbers,  // Send all target numbers
      timeLeft: game.timeLeft,
      currentRound: game.currentRound,
      totalRounds: TOTAL_ROUNDS,
      players: playerArray.map(p => ({
        nickname: p.nickname,
        ready: p.ready
      }))
    });
    
    // Log the target numbers to verify they're correct
    console.log(`Target numbers for game ${gamePin}:`, game.targetNumbers);
    
    // Send individual target numbers to each player
    playerArray.forEach((player, index) => {
      // In round 1, player 0 gets targetNumbers[0], player 1 gets targetNumbers[1], etc.
      const targetNumber = game.targetNumbers[index];
      
      // Ensure target number is valid
      if (targetNumber === undefined || targetNumber === null || isNaN(targetNumber)) {
        console.error(`Invalid target number ${targetNumber} for player ${player.nickname} (index ${index})`);
        return;
      }
      
      console.log(`Sending target number ${targetNumber} to player ${player.nickname} (ID: ${player.id}) for round 1`);
      
      // Emit directly to the specific player's socket
      io.to(player.id).emit('game:player_target', {
        targetNumber,
        playerIndex: index,
        currentRound: 1
      });
    });
    
    // Start the game timer
    startGameTimer(gamePin);
    
    console.log(`Game ${gamePin} started with target numbers: ${game.targetNumbers.join(', ')}`);
  });

  // Student submits an equation
  socket.on('student:submit_equation', (data) => {
    const { gamePin, equation, result } = data;
    
    if (!games[gamePin] || games[gamePin].status !== 'active') {
      return;
    }
    
    const game = games[gamePin];
    const player = game.players[socket.id];
    
    if (!player) {
      return;
    }
    
    const currentRoundIndex = game.currentRound - 1;
    
    // Get the player's index
    const playerIndex = game.playerIndex[player.nickname];
    if (playerIndex === undefined) {
      console.error(`Player ${player.nickname} has no index assigned in game ${gamePin}`);
      socket.emit('equation:incorrect', { equation });
      return;
    }
    
    // Calculate which target number this player should have for the current round
    const targetIndex = (playerIndex + currentRoundIndex) % 4;
    const targetNumber = game.targetNumbers[targetIndex];
    
    console.log(`Player ${player.nickname} (index ${playerIndex}) submitted equation for target ${targetNumber} (index ${targetIndex}) in round ${game.currentRound}`);
    
    // Check if the equation result matches the player's target number for this round
    if (result === targetNumber) {
      // Check for duplicate
      const isDuplicate = checkDuplicate(gamePin, player.nickname, equation);
      
      if (isDuplicate) {
        // Duplicate equation
        player.stats[currentRoundIndex].duplicate++;
        game.gameStats[player.nickname][currentRoundIndex].duplicate++;
        
        socket.emit('equation:duplicate', { equation });
        
        // Update teacher view with new stats
        updateTeacherStats(gamePin);
      } else {
        // Correct equation
        player.stats[currentRoundIndex].correct++;
        game.gameStats[player.nickname][currentRoundIndex].correct++;
        
        // Save the equation with target number information
        if (!game.equations) {
          game.equations = {};
        }
        if (!game.equations[player.nickname]) {
          game.equations[player.nickname] = {};
        }
        // Track equations by target number
        if (!game.equations[player.nickname][targetNumber]) {
          game.equations[player.nickname][targetNumber] = [];
        }
        game.equations[player.nickname][targetNumber].push({
          equation,
          round: game.currentRound,
          targetIndex,
          playerIndex // Store the player's index for consistent coloring
        });
        
        // Send confirmation to the submitting player
        socket.emit('equation:correct', { equation });
        
        // Broadcast the correct equation to all players in the room
        io.to(gamePin).emit('player:correct_equation', {
          nickname: player.nickname,
          equation,
          targetNumber,
          round: game.currentRound,
          playerIndex // Include player index for consistent coloring
        });
        
        // Update teacher view with new stats
        updateTeacherStats(gamePin);
      }
    } else {
      // Incorrect equation
      player.stats[currentRoundIndex].incorrect++;
      game.gameStats[player.nickname][currentRoundIndex].incorrect++;
      
      socket.emit('equation:incorrect', { equation });
      
      // Update teacher view with new stats
      updateTeacherStats(gamePin);
    }
    
  });

  // Teacher pauses/resumes the game
  socket.on('teacher:toggle_pause', (data) => {
    const { gamePin } = data;
    
    if (!games[gamePin]) {
      socket.emit('game:error', { message: 'Game not found' });
      return;
    }
    
    const game = games[gamePin];
    
    if (socket.id !== game.teacherId) {
      socket.emit('game:error', { message: 'Only the teacher can pause/resume the game' });
      return;
    }
    
    if (game.status === 'active') {
      // Pause the game
      game.status = 'paused';
      game.pausedByTeacher = true; // Flag that teacher intentionally paused
      clearInterval(game.timerInterval);
      io.to(gamePin).emit('game:paused', { message: 'Game Paused by Teacher' });
    } else if (game.status === 'paused') {
      // Resume the game
      game.status = 'active';
      game.pausedByTeacher = false; // Clear the flag
      startGameTimer(gamePin);
      io.to(gamePin).emit('game:resumed', { timeLeft: game.timeLeft });
    }
  });

  // Handle disconnections
  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
    
    // Check if this was a teacher
    for (const pin in games) {
      if (games[pin].teacherId === socket.id) {
        console.log(`Teacher disconnected from game ${pin}, but game will be preserved`);
        
        // Pause the game if it's active
        if (games[pin].status === 'active' && games[pin].timerInterval) {
          clearInterval(games[pin].timerInterval);
          games[pin].status = 'paused';
          io.to(pin).emit('game:paused', { message: 'Game paused. Teacher reconnecting...' });
        }
        
        // Mark teacher as temporarily disconnected but don't delete the game
        games[pin].teacherConnected = false;
        break;
      }
    }
    
    // Check if this was a student
    for (const pin in games) {
      if (games[pin].players[socket.id]) {
        const nickname = games[pin].players[socket.id].nickname;
        
        // Remove player from game
        delete games[pin].players[socket.id];
        games[pin].playerCount--;
        
        // Notify teacher
        io.to(games[pin].teacherId).emit('game:player_left', {
          players: Object.values(games[pin].players).map(p => ({
            nickname: p.nickname,
            ready: p.ready
          })),
          playerCount: games[pin].playerCount,
          leftNickname: nickname
        });
        
        console.log(`Player ${nickname} left game ${pin}`);
        break;
      }
    }
  });
});

// Helper functions
function startGameTimer(gamePin) {
  const game = games[gamePin];
  
    if (game.timerInterval) {
      clearInterval(game.timerInterval);
    }
   
    console.log(`Starting game timer for game ${gamePin}, timeLeft: ${game.timeLeft}`);
  
  game.timerInterval = setInterval(() => {
    game.timeLeft--;
    
    // Send time update to all clients
    io.to(gamePin).emit('game:time_update', { 
      timeLeft: game.timeLeft,
      currentRound: game.currentRound
      });
      
      // console.log(`Game ${gamePin} timer: ${game.timeLeft}`);
      
      if (game.timeLeft <= 0) {
      clearInterval(game.timerInterval);
      
      if (game.currentRound < TOTAL_ROUNDS) {
        // Prepare for next round
        handleRoundTransition(gamePin);
      } else {
        // Game over
        endGame(gamePin);
      }
    }
  }, 1000);
}

function handleRoundTransition(gamePin) {
  const game = games[gamePin];
  
  // Send "Time's Up!" message
  io.to(gamePin).emit('game:times_up');
  
  // Wait 3 seconds
  setTimeout(() => {
    // Send "Get ready to switch" message
    io.to(gamePin).emit('game:get_ready');
    
    // Wait 3 seconds
    setTimeout(() => {
      game.currentRound++;
      
      // Send round number
      io.to(gamePin).emit('game:round_announcement', { round: game.currentRound });
      
      // Wait 2 seconds
      setTimeout(() => {
        // Send countdown
        io.to(gamePin).emit('game:countdown', { message: 'Ready...' });
        
        setTimeout(() => {
          io.to(gamePin).emit('game:countdown', { message: 'Set...' });
          
          setTimeout(() => {
            io.to(gamePin).emit('game:countdown', { message: 'Go!' });
            
            // Wait 1 second then start the next round
            setTimeout(() => {
              game.timeLeft = ROUND_DURATION;
              
              // Calculate and send new target numbers for each player based on round rotation
              const playerArray = Object.values(game.players);
              
              // Log target numbers for verification
              console.log(`Round ${game.currentRound} target numbers:`, game.targetNumbers);
              
              // Send general round start event
              io.to(gamePin).emit('game:round_start', {
                timeLeft: game.timeLeft,
                currentRound: game.currentRound
              });
              
              // Send individual target numbers to each player
              playerArray.forEach((player) => {
                const playerIndex = game.playerIndex[player.nickname];
                if (playerIndex === undefined) {
                  console.error(`Player ${player.nickname} has no index assigned in game ${gamePin}`);
                  return;
                }
                
                // Calculate which target number this player should get for this round
                // Round 1: player 0 → target 0, player 1 → target 1, player 2 → target 2, player 3 → target 3
                // Round 2: player 0 → target 1, player 1 → target 2, player 2 → target 3, player 3 → target 0
                // Round 3: player 0 → target 2, player 1 → target 3, player 2 → target 0, player 3 → target 1
                // Round 4: player 0 → target 3, player 1 → target 0, player 2 → target 1, player 3 → target 2
                const targetIndex = (playerIndex + game.currentRound - 1) % 4;
                const targetNumber = game.targetNumbers[targetIndex];
                
                // Ensure target number is valid
                if (targetNumber === undefined || targetNumber === null || isNaN(targetNumber)) {
                  console.error(`Invalid target number ${targetNumber} for player ${player.nickname} (index ${playerIndex}, target index ${targetIndex})`);
                  return;
                }
                
                console.log(`Round ${game.currentRound}: Player ${player.nickname} (index ${playerIndex}) gets target number ${targetNumber} (index ${targetIndex})`);
                
                // Emit directly to the specific player's socket
                io.to(player.id).emit('game:player_target', {
                  targetNumber,
                  playerIndex,
                  currentRound: game.currentRound
                });
              });
              
              // Start the timer for the new round
              startGameTimer(gamePin);
            }, 1000);
          }, 1000);
        }, 1000);
      }, 2000);
    }, 3000);
  }, 3000);
}

function endGame(gamePin) {
  const game = games[gamePin];
  
  // Send "Time's Up!" message
  io.to(gamePin).emit('game:times_up');
  
  // Wait 3 seconds
  setTimeout(() => {
    // Send "End of Game" message
    io.to(gamePin).emit('game:end');
    
    // Wait 1 second
    setTimeout(() => {
    // Calculate final game stats for all players
    const finalGameStats = calculateFinalGameStats(game);
    
    // Send final stats to all players
    io.to(gamePin).emit('game:stats', {
      gameStats: game.gameStats,
      targetNumbers: game.targetNumbers,
      finalGameStats: finalGameStats,
      playerStats: game.gameStats // Include player-specific stats
    });
    
    // Send final stats to teacher with a specific event
    io.to(game.teacherId).emit('game:final_stats', {
      gameStats: game.gameStats,
      finalGameStats: finalGameStats
    });
    
    game.status = 'completed';
    }, 1000);
  }, 3000);
}

function checkDuplicate(gamePin, nickname, equation) {
  const game = games[gamePin];
  
  if (!game.equations) {
    return false;
  }
  
  // Get the player's current target number
  const playerIndex = game.playerIndex[nickname];
  if (playerIndex === undefined) {
    return false;
  }
  
  const currentRoundIndex = game.currentRound - 1;
  const targetIndex = (playerIndex + currentRoundIndex) % 4;
  const targetNumber = game.targetNumbers[targetIndex];
  
  // Check if this equation already exists for ANY player for this target number
  for (const playerName in game.equations) {
    // Skip if this player doesn't have equations for this target number
    if (!game.equations[playerName][targetNumber]) {
      continue;
    }
    
    // Check if any player has already submitted this equation for this target
    const isDuplicate = game.equations[playerName][targetNumber].some(entry => entry.equation === equation);
    if (isDuplicate) {
      return true;
    }
  }
  
  return false;
}

// Calculate final game stats for all players
function calculateFinalGameStats(game) {
  const finalStats = {};
  
  // For each player
  Object.keys(game.gameStats).forEach(nickname => {
    const playerRoundStats = game.gameStats[nickname];
    let totalCorrect = 0;
    let totalIncorrect = 0;
    let totalDuplicate = 0;
    
    // Sum up stats from all rounds
    playerRoundStats.forEach(roundStats => {
      totalCorrect += roundStats.correct || 0;
      totalIncorrect += roundStats.incorrect || 0;
      totalDuplicate += roundStats.duplicate || 0;
    });
    
    // Calculate accuracy - only count non-duplicate correct answers
    const totalAttempts = totalCorrect + totalIncorrect + totalDuplicate;
    // Only count non-duplicate answers as correct for accuracy calculation
    const accuracy = totalAttempts > 0 ? ((totalCorrect) / totalAttempts) * 100 : 0;
    
    // Store final stats for this player
    finalStats[nickname] = {
      correct: totalCorrect,
      incorrect: totalIncorrect,
      duplicate: totalDuplicate,
      accuracy: accuracy.toFixed(1) + '%'
    };
  });
  
  return finalStats;
}

function updateTeacherStats(gamePin) {
  const game = games[gamePin];
  
  if (!game) {
    return;
  }
  
  // Create player target mapping for the current round
  const playerTargets = {};
  if (game.playerIndex) {
    Object.keys(game.playerIndex).forEach(nickname => {
      const playerIndex = game.playerIndex[nickname];
      const currentRoundIndex = game.currentRound - 1;
      const targetIndex = (playerIndex + currentRoundIndex) % 4;
      const targetNumber = game.targetNumbers[targetIndex];
      playerTargets[nickname] = targetNumber;
    });
  }
  
  // Send updated stats to all clients in the game room
  // This ensures all connected teachers get the updates
  io.to(gamePin).emit('game:stats_update', {
    gameStats: game.gameStats,
    currentRound: game.currentRound,
    targetNumber: game.targetNumbers[game.currentRound - 1],
    playerTargets: playerTargets // Include player-specific target numbers
  });
}

// Start the server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

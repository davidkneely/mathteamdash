# Team Number Dash - Multiplayer Math Game

Team Number Dash is a multiplayer math game where students solve math challenges by creating equations that equal a target number.

## Project Structure

- `server.js` - Node.js server using Express and Socket.IO
- `utils.js` - Helper functions for the server
- `package.json` - Node.js dependencies
- HTML files:
  - `teacher_signin.html` - Teacher login page
  - `teacher_gamestart.html` - Game lobby for teachers
  - `teacher_gameview.html` - Live game monitoring for teachers
  - `student_pin.html` - Game pin entry for students
  - `student_name.html` - Nickname entry for students
  - `student_game.html` - Main game interface for students

## Setup Instructions

1. Install Node.js and npm if you don't have them already
2. Clone this repository
3. Navigate to the project directory
4. Install dependencies:

```bash
npm install
```

5. Start the server:

```bash
npm start
```

6. Open your browser and navigate to:
   - Teacher: http://64.227.45.55:3000/teacher_signin.html
   - Students: http://64.227.45.55:3000/student_pin.html

## Game Flow

1. Teacher signs in and gets a game pin
2. Students enter the game pin and their nicknames
3. Teacher sees students joining in the lobby
4. Teacher starts the game when ready
5. All players see the game start with the same target number
6. Students create equations that equal the target number
7. Teacher monitors progress in real-time
8. After 4 rounds, game ends and displays statistics

## Game Rules

- Each round has a random target number
- Students must create equations that equal the target number
- Duplicate equations are not allowed
- Each round lasts 60 seconds
- After 4 rounds, the game ends and shows statistics

## Technologies Used

- Node.js
- Express
- Socket.IO
- HTML/CSS/JavaScript
# mathteamdash

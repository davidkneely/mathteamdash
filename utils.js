/**
 * Generate a random 5-digit game pin
 * @returns {string} 5-digit game pin
 */
function generateGamePin() {
  return Math.floor(10000 + Math.random() * 90000).toString();
}

/**
 * Generate random two-digit target numbers for each round
 * @param {number} count - Number of target numbers to generate
 * @returns {number[]} Array of target numbers
 */
function generateTargetNumbers(count) {
  const numbers = [];
  const usedNumbers = new Set();
  
  for (let i = 0; i < count; i++) {
    let num;
    // Ensure we get distinct numbers
    do {
      num = Math.floor(Math.random() * 90) + 10; // Random number between 10 and 99
    } while (usedNumbers.has(num));
    
    usedNumbers.add(num);
    numbers.push(num);
  }
  
  console.log(`Generated ${count} target numbers:`, numbers);
  return numbers;
}

module.exports = {
  generateGamePin,
  generateTargetNumbers
};

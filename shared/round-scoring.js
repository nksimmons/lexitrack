function scoreRound(roundWords, options) {
  const getBaseScore = options.getBaseScore;
  const getLengthBonus = options.getLengthBonus;
  const uniqueBonus = options.uniqueBonus;

  const allWords = new Map();
  for (const [pid, words] of roundWords) {
    for (const entry of words) {
      if (!entry.valid) continue;
      if (!allWords.has(entry.word)) allWords.set(entry.word, []);
      allWords.get(entry.word).push(pid);
    }
  }

  const commonItems = [];
  const commonScores = {};
  for (const [word, finders] of allWords) {
    if (finders.length < 2) continue;
    const base = getBaseScore(word.length);
    const lengthBonus = getLengthBonus(word.length);
    const total = base + lengthBonus;
    commonItems.push({ word, score: total, playerIds: finders });
    for (const pid of finders) {
      commonScores[pid] = (commonScores[pid] || 0) + total;
    }
  }

  const uniqueItems = [];
  const uniqueScores = {};
  for (const [word, finders] of allWords) {
    if (finders.length !== 1) continue;
    const pid = finders[0];
    const base = getBaseScore(word.length);
    const lengthBonus = getLengthBonus(word.length);
    const total = base + lengthBonus + uniqueBonus;
    uniqueItems.push({
      playerId: pid,
      word,
      baseScore: base,
      lengthBonus,
      uniqueBonus,
      totalScore: total,
    });
    uniqueScores[pid] = (uniqueScores[pid] || 0) + total;
  }

  for (const [pid, words] of roundWords) {
    for (const entry of words) {
      if (!entry.valid) {
        entry.finalScore = 0;
        entry.reason = 'invalid';
        continue;
      }

      const finders = allWords.get(entry.word) || [];
      if (finders.length > 1) {
        entry.finalScore = getBaseScore(entry.word.length) + getLengthBonus(entry.word.length);
        entry.reason = 'common';
      } else {
        entry.finalScore = getBaseScore(entry.word.length) + getLengthBonus(entry.word.length) + uniqueBonus;
        entry.reason = 'unique';
      }
    }

    if (!commonScores[pid]) commonScores[pid] = 0;
    if (!uniqueScores[pid]) uniqueScores[pid] = 0;
  }

  const playerRoundScores = {};
  for (const [pid] of roundWords) {
    playerRoundScores[pid] = (commonScores[pid] || 0) + (uniqueScores[pid] || 0);
  }

  return {
    commonItems,
    uniqueItems,
    playerRoundScores,
  };
}

module.exports = {
  scoreRound,
};

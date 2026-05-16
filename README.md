# LexiTrack 🧩

**LexiTrack** is an open-source, fast-paced word search game. Challenge your vocabulary by tracking paths through a grid of letters to find as many words as possible before the timer runs out.

## ✨ Features

* **Dynamic Grid:** Randomly generated letter grids (4×4 up to 7×7) for infinite replayability.
* **Path Tracking:** Intuitive trace-to-select mechanics — drag across adjacent letters to form words.
* **Multiplayer:** 2–8 players connect over WebRTC, no server required. Host controls the board, timer, and scoring.
* **Shared-word penalty:** Words found by more than one player score zero — find the rare ones to pull ahead.
* **Configurable rounds:** Host can tune grid size, number of rounds, and round duration before starting.
* **Open Source:** Built for the community, by the community.

## 🚀 Getting Started

### Prerequisites

* Node.js v18+

### Installation

1. Clone the repository:
   ```bash
   git clone https://github.com/nksimmons/games.git
   cd games/boggle
   ```
2. Install dependencies:
   ```bash
   npm install
   ```
3. Run the game server:
   ```bash
   npm start
   ```
4. Open the host page in a browser and share the QR code with players.

## 📜 How to Play

1. The host starts a round — a grid of letters appears on every player's screen.
2. Drag or click through **adjacent** letters (horizontal, vertical, or diagonal) to spell words.
3. Words must be at least 3 letters and appear in the dictionary.
4. Each letter may only be used once per word.
5. Score points based on word length — longer words score more.
6. Words found by multiple players cancel out (score 0 for both).
7. After all rounds, the player with the most points wins.

### Scoring

| Word length | Points |
|-------------|--------|
| 3 letters | 1 |
| 4 letters | 1 |
| 5 letters | 2 |
| 6 letters | 3 |
| 7 letters | 5 |
| 8+ letters | 11 |

## Multiplayer Modes

| Page | Purpose |
|------|---------|
| `public/combined.html` | Host + play on one device (recommended for mobile) |
| `public/host.html` | Dedicated host screen — shows QR code for players to scan |
| `public/player.html` | Player join page — scan QR code or follow link from host |

Players connect peer-to-peer via [Trystero](https://github.com/dmotz/trystero) (Nostr WebRTC relay). No server needed for the GitHub Pages deployment.

## ⚖️ Legal Disclaimer

LexiTrack is an independent open-source project. It is a functional implementation of a word-grid game and is not affiliated with, sponsored by, or endorsed by Hasbro, Inc. or the Boggle brand.

## 📄 License

This project is licensed under the [MIT License](LICENSE).


## How It Works

- **Host display** (`/host`) — authoritative game runtime. Shows board, timer, scores, and round results.
- **Player page** (`/player`) — players join via manual offer/answer code exchange, then create a name + avatar and play by swipe/tap.

### Game Rules

- **Board**: 16 classic Boggle dice are shuffled to create a 4×4 grid each round
- **Timer**: 90 seconds per round, 5 rounds per game
- **Word entry**: Swipe/tap adjacent letters on the board, or type words manually
- **Scoring** (classic Boggle):
  - 3–4 letters: 1 point
  - 5 letters: 2 points
  - 6 letters: 3 points
  - 7 letters: 5 points
  - 8+ letters: 11 points
- **Shared words score 0**: If two players find the same word, neither gets points (classic competitive Boggle rule)
- **Dictionary**: ~370K English words

## Quick Start (No Backend)

Serve the repository as static files (GitHub Pages, `npx serve`, etc). No Node game server is required.

1. Open host page on TV/main device: `/boggle/public/host.html`
2. Click `Create Player Offer` on host and copy the generated code
3. Open player page on phone: `/boggle/public/player.html`
4. Paste host offer code on player, then copy answer code back to host
5. Click `Apply Player Answer` on host and paste the player answer code
6. Player can now join and play

Repeat steps 2-5 for additional players.

## Tech Stack

- **WebRTC DataChannels** for peer-to-peer multiplayer
- **STUN** (public Google STUN) for NAT traversal
- Vanilla HTML/CSS/JS — no build step, no framework
- Host-authoritative game engine runs fully in browser

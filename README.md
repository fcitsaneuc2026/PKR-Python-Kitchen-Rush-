# Python Kitchen Rush — Prototype V0.1

## Included features

- Individual player sessions
- 10-minute Burger Rush challenge
- Phaser 2D kitchen window
- Coordinate-based movement
- Actual Python execution through Pyodide
- Safe, limited game command API
- Backpack with 3 item slots
- Chests, cutting boards, cooking pans; plate counter, wash sink, and serve counter are kept for later
- Visual state changes for lettuce, bread, tomato, and patty
- Score calculated after orders are served
- Central SQLite leaderboard
- LAN-ready FastAPI server

## Windows 10/11 setup

1. Install Python 3.11 or newer:
   https://www.python.org/downloads/

2. Open PowerShell in this project folder.

3. Create a virtual environment:

   ```powershell
   py -m venv .venv
   .\.venv\Scripts\Activate.ps1
   ```

4. Install dependencies:

   ```powershell
   pip install -r requirements.txt
   ```

5. Start the server:

   ```powershell
   python -m uvicorn server:app --host 0.0.0.0 --port 8000
   ```

6. On the server computer, open:

   http://127.0.0.1:8000

7. Find the server computer's LAN IPv4 address:

   ```powershell
   ipconfig
   ```

   Look for IPv4 Address, for example `192.168.1.105`.

8. On student computers connected to the same Wi-Fi/LAN, open:

   http://192.168.1.105:8000

## Windows Firewall

If other computers cannot connect, allow Python or TCP port 8000 through Windows Defender Firewall on the server computer.

For a temporary private computer-room test, create an inbound rule for TCP 8000 on the Private network profile only.

## Important prototype limitations

- Pyodide and Phaser are loaded from public CDNs, so the first browser load needs internet access unless you later download/vendor those assets locally.
- The score endpoint is suitable for a trusted classroom prototype, not a public competition. A production version should verify gameplay server-side, add authentication, rate limits, and anti-cheat checks.
- The current prototype is individual-session gameplay. It does not synchronize players inside the kitchen.
- The game currently uses emoji-style visual assets as placeholders. Replace them with pixel-art sprites later.

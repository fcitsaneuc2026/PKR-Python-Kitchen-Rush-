from datetime import datetime, timezone
from pathlib import Path
import sqlite3
from fastapi import FastAPI, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "leaderboard.db"

app = FastAPI(title="Python Kitchen Rush")

class ScoreSubmission(BaseModel):
    player_name: str = Field(min_length=1, max_length=24)
    score: int = Field(ge=0, le=1_000_000)
    game_mode: str = Field(min_length=1, max_length=50)
    time_completed: str
    orders_completed: int = Field(ge=0, le=10000)

def db():
    connection = sqlite3.connect(DB_PATH)
    connection.row_factory = sqlite3.Row
    return connection

def init_db():
    with db() as conn:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            player_name TEXT NOT NULL,
            score INTEGER NOT NULL,
            game_mode TEXT NOT NULL,
            time_completed TEXT NOT NULL,
            orders_completed INTEGER NOT NULL
        )
        """)
        conn.commit()

@app.on_event("startup")
def startup():
    init_db()

@app.get("/api/health")
def health():
    return {"status": "ok"}

@app.post("/api/scores")
def submit_score(submission: ScoreSubmission):
    # Prototype validation. For a public deployment, add authentication,
    # server-side replay verification, rate limits, and stronger anti-cheat.
    with db() as conn:
        conn.execute("""
            INSERT INTO scores (player_name, score, game_mode, time_completed, orders_completed)
            VALUES (?, ?, ?, ?, ?)
        """, (
            submission.player_name.strip(),
            submission.score,
            submission.game_mode,
            submission.time_completed,
            submission.orders_completed,
        ))
        conn.commit()
    return {"saved": True}

@app.get("/api/leaderboard")
def leaderboard():
    with db() as conn:
        rows = conn.execute("""
            SELECT player_name, score, game_mode, time_completed, orders_completed
            FROM scores
            ORDER BY score DESC, orders_completed DESC, time_completed ASC
            LIMIT 100
        """).fetchall()
    return [dict(row) for row in rows]

app.mount("/static", StaticFiles(directory=BASE_DIR / "frontend"), name="static")

@app.get("/")
def index():
    return FileResponse(BASE_DIR / "frontend" / "index.html")

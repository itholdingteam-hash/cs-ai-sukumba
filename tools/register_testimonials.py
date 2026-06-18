#!/usr/bin/env python3
import sqlite3
from datetime import datetime
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DB_FILE = ROOT / "data" / "admin_panel.db"
TESTIMONI_DIR = ROOT / "admin-panel" / "static" / "uploads" / "testimoni"
ALLOWED_SUFFIXES = {".jpg", ".jpeg", ".png", ".webp", ".mp4", ".mov", ".webm"}


def main():
    TESTIMONI_DIR.mkdir(parents=True, exist_ok=True)
    files = sorted(
        p for p in TESTIMONI_DIR.iterdir()
        if p.is_file() and p.suffix.lower() in ALLOWED_SUFFIXES
    )
    if not files:
        print(f"Tidak ada file testimoni di {TESTIMONI_DIR}")
        return

    now = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    con = sqlite3.connect(DB_FILE)
    cur = con.cursor()
    cur.execute(
        """
        CREATE TABLE IF NOT EXISTS testimonials (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            caption TEXT DEFAULT '',
            media_url TEXT NOT NULL,
            media_type TEXT DEFAULT 'image',
            sort_order INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
        """
    )
    inserted = 0
    for idx, path in enumerate(files, start=1):
        media_url = f"/static/uploads/testimoni/{path.name}"
        title = f"Testimoni Sukumba {idx:02d}"
        caption = "Berikut testimoni asli customer SUKUMBA."
        media_type = "video" if path.suffix.lower() in {".mp4", ".mov", ".webm"} else "image"
        existing = cur.execute(
            "SELECT id FROM testimonials WHERE media_url = ? LIMIT 1",
            (media_url,),
        ).fetchone()
        if existing:
            cur.execute(
                """
                UPDATE testimonials
                SET title = ?, caption = ?, media_type = ?, sort_order = ?,
                    active = 1, updated_at = ?
                WHERE id = ?
                """,
                (title, caption, media_type, idx, now, existing[0]),
            )
        else:
            cur.execute(
                """
                INSERT INTO testimonials
                    (title, caption, media_url, media_type, sort_order, active, created_at, updated_at)
                VALUES
                    (?, ?, ?, ?, ?, 1, ?, ?)
                """,
                (title, caption, media_url, media_type, idx, now, now),
            )
            inserted += 1
    con.commit()
    con.close()
    print(f"Terdaftar {len(files)} file testimoni. Baru ditambahkan: {inserted}. Update: {now}")


if __name__ == "__main__":
    main()

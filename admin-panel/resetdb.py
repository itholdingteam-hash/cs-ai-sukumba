import os
import sqlite3
import sys
from pathlib import Path


ROOT_DIR = Path(__file__).resolve().parents[1]
DB_FILE = Path(os.getenv("DB_PATH", ROOT_DIR / "data" / "admin_panel.db"))
TABLES_TO_CLEAR = ("conversation_logs", "conversation_history", "orders")


def main():
    if "--yes" not in sys.argv:
        print("Refusing to reset database without --yes.")
        print(f"Target database: {DB_FILE}")
        print("Usage: python resetdb.py --yes")
        return 1

    if not DB_FILE.exists():
        print(f"Database not found: {DB_FILE}")
        return 1

    with sqlite3.connect(DB_FILE) as conn:
        cursor = conn.cursor()
        for table in TABLES_TO_CLEAR:
            cursor.execute(f"DELETE FROM {table}")
        conn.commit()

        for table in TABLES_TO_CLEAR:
            count = cursor.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            print(f"{table}: {count}")

    print("Database reset complete.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

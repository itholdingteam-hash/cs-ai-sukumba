"""SQLite connection and schema bootstrap for the admin panel."""

from contextlib import contextmanager
from datetime import datetime
import json
import sqlite3

from .default_templates import DEFAULT_CS_TEMPLATES, default_settings


_db_file = None
_telegram_bot_token = ''
_logger = None


def configure_database(db_file, telegram_bot_token='', logger=None):
    global _db_file, _telegram_bot_token, _logger
    _db_file = db_file
    _telegram_bot_token = telegram_bot_token or ''
    _logger = logger


def _log_info(message):
    if _logger:
        _logger.info(message)


def _log_warning(message):
    if _logger:
        _logger.warning(message)


@contextmanager
def get_db():
    if not _db_file:
        raise RuntimeError('Database is not configured')
    conn = sqlite3.connect(_db_file, timeout=30)
    conn.row_factory = sqlite3.Row
    conn.execute('PRAGMA busy_timeout = 30000')
    conn.execute('PRAGMA foreign_keys = ON')
    try:
        yield conn
        conn.commit()
    except Exception:
        conn.rollback()
        raise
    finally:
        conn.close()


def init_db():
    with get_db() as conn:
        c = conn.cursor()
        try:
            c.execute('PRAGMA journal_mode = DELETE')
            c.execute('PRAGMA synchronous = NORMAL')
        except sqlite3.OperationalError as exc:
            _log_warning(f'Could not switch SQLite journal mode: {exc}')

        c.execute('''CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY, value TEXT NOT NULL)''')

        c.execute('''CREATE TABLE IF NOT EXISTS products (
            id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL,
            price TEXT NOT NULL, speed TEXT NOT NULL, features TEXT NOT NULL,
            promo TEXT, target TEXT, image_url TEXT, description TEXT,
            active INTEGER DEFAULT 1)''')

        c.execute('''CREATE TABLE IF NOT EXISTS faqs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, question TEXT NOT NULL,
            answer TEXT NOT NULL, image_url TEXT, active INTEGER DEFAULT 1)''')

        c.execute("""
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
        """)

        c.execute("""
            CREATE TABLE IF NOT EXISTS cs_templates (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL,
                content TEXT NOT NULL,
                active INTEGER DEFAULT 1,
                created_at TEXT DEFAULT CURRENT_TIMESTAMP,
                updated_at TEXT DEFAULT CURRENT_TIMESTAMP
            )
        """)

        for sql in [
            "ALTER TABLE cs_templates ADD COLUMN active INTEGER DEFAULT 1",
            "ALTER TABLE cs_templates ADD COLUMN created_at TEXT DEFAULT ''",
            "ALTER TABLE cs_templates ADD COLUMN updated_at TEXT DEFAULT ''",
        ]:
            try:
                c.execute(sql)
            except sqlite3.OperationalError:
                pass

        c.execute('''CREATE TABLE IF NOT EXISTS conversation_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            user_number TEXT, user_message TEXT, ai_response TEXT, kb_context TEXT)''')

        c.execute('''CREATE TABLE IF NOT EXISTS conversation_history (
            id INTEGER PRIMARY KEY AUTOINCREMENT, user_number TEXT,
            role TEXT, content TEXT, timestamp TEXT)''')

        c.execute('''CREATE TABLE IF NOT EXISTS customer_profiles (
            user_number TEXT PRIMARY KEY,
            profile_json TEXT DEFAULT '{}',
            summary TEXT DEFAULT '',
            created_at TEXT,
            updated_at TEXT)''')

        c.execute('''CREATE TABLE IF NOT EXISTS ai_system_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            item_type TEXT NOT NULL,
            title TEXT NOT NULL,
            content TEXT DEFAULT '',
            status TEXT DEFAULT 'draft',
            tags TEXT DEFAULT '',
            source_user_number TEXT DEFAULT '',
            reviewer_note TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP)''')

        c.execute('''CREATE TABLE IF NOT EXISTS orders (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT NOT NULL,
            public_order_id TEXT DEFAULT '', product_code TEXT DEFAULT '',
            user_number TEXT, user_name TEXT, phone TEXT, address TEXT,
            product TEXT, quantity TEXT, notes TEXT, status TEXT DEFAULT 'new',
            total TEXT, idempotency_key TEXT DEFAULT '', source TEXT DEFAULT 'WhatsApp',
            updated_at TEXT DEFAULT '')''')

        c.execute('''CREATE TABLE IF NOT EXISTS payment_proofs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            order_id INTEGER,
            user_number TEXT NOT NULL,
            caption TEXT DEFAULT '',
            media_url TEXT NOT NULL,
            mime_type TEXT DEFAULT '',
            amount TEXT DEFAULT '',
            status TEXT DEFAULT 'pending',
            reviewer_note TEXT DEFAULT '',
            created_at TEXT NOT NULL,
            updated_at TEXT DEFAULT '',
            FOREIGN KEY(order_id) REFERENCES orders(id)
        )''')

        c.execute('''CREATE TABLE IF NOT EXISTS shipping_rates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            province TEXT DEFAULT '',
            city TEXT NOT NULL,
            district TEXT DEFAULT '',
            courier TEXT DEFAULT 'JNE',
            service TEXT DEFAULT 'REG',
            shipping_cost INTEGER NOT NULL,
            estimated_days TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )''')

        c.execute('''CREATE TABLE IF NOT EXISTS closings (
            id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, created_at TEXT,
            user_wa TEXT, raw_text TEXT, nama TEXT DEFAULT '', alamat TEXT DEFAULT '',
            telepon TEXT DEFAULT '', kode_pos TEXT DEFAULT '', berat TEXT DEFAULT '1',
            harga_non_cod TEXT DEFAULT '', nilai_cod TEXT DEFAULT '', produk TEXT DEFAULT '',
            kelurahan TEXT DEFAULT '', qty TEXT DEFAULT '1', instruksi TEXT DEFAULT '',
            courier TEXT DEFAULT '', gudang TEXT DEFAULT '', status TEXT DEFAULT 'draft',
            source TEXT DEFAULT 'Manual')''')

        c.execute('''CREATE TABLE IF NOT EXISTS telegram_users (
            id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id TEXT UNIQUE NOT NULL,
            name TEXT NOT NULL, created_at TEXT)''')

        _migrate_legacy_columns(c)
        _create_indexes(c)
        _seed_defaults(c)
        _migrate_testimonials_from_faqs(c)

        _log_info(f"Database initialized at: {_db_file}")


def _migrate_legacy_columns(cursor):
    for col, default in [('image_url', "''"), ('description', "''")]:
        try:
            cursor.execute(f'ALTER TABLE products ADD COLUMN {col} TEXT DEFAULT {default}')
        except sqlite3.OperationalError:
            pass
    try:
        cursor.execute('ALTER TABLE faqs ADD COLUMN image_url TEXT')
    except sqlite3.OperationalError:
        pass
    for col, col_type, default in [
        ('caption', 'TEXT', "''"),
        ('media_type', 'TEXT', "'image'"),
        ('sort_order', 'INTEGER', '0'),
        ('active', 'INTEGER', '1'),
        ('created_at', 'TEXT', "''"),
        ('updated_at', 'TEXT', "''"),
    ]:
        try:
            cursor.execute(f'ALTER TABLE testimonials ADD COLUMN {col} {col_type} DEFAULT {default}')
        except sqlite3.OperationalError:
            pass
    for col, col_type, default in [
        ('public_order_id', 'TEXT', "''"),
        ('product_code', 'TEXT', "''"),
        ('idempotency_key', 'TEXT', "''"),
        ('source', 'TEXT', "'WhatsApp'"),
        ('updated_at', 'TEXT', "''"),
    ]:
        try:
            cursor.execute(f'ALTER TABLE orders ADD COLUMN {col} {col_type} DEFAULT {default}')
        except sqlite3.OperationalError:
            pass
    for col, col_type, default in [
        ('order_id', 'INTEGER', 'NULL'),
        ('caption', 'TEXT', "''"),
        ('mime_type', 'TEXT', "''"),
        ('amount', 'TEXT', "''"),
        ('status', 'TEXT', "'pending'"),
        ('reviewer_note', 'TEXT', "''"),
        ('updated_at', 'TEXT', "''"),
    ]:
        try:
            cursor.execute(f'ALTER TABLE payment_proofs ADD COLUMN {col} {col_type} DEFAULT {default}')
        except sqlite3.OperationalError:
            pass
    for col, col_type, default in [
        ('province', 'TEXT', "''"),
        ('district', 'TEXT', "''"),
        ('courier', 'TEXT', "'JNE'"),
        ('service', 'TEXT', "'REG'"),
        ('estimated_days', 'TEXT', "''"),
        ('notes', 'TEXT', "''"),
        ('active', 'INTEGER', '1'),
        ('created_at', 'TEXT', "''"),
        ('updated_at', 'TEXT', "''"),
    ]:
        try:
            cursor.execute(f'ALTER TABLE shipping_rates ADD COLUMN {col} {col_type} DEFAULT {default}')
        except sqlite3.OperationalError:
            pass
    for col, default in [('source', "'Manual'"), ('created_at', "''")]:
        try:
            cursor.execute(f'ALTER TABLE closings ADD COLUMN {col} TEXT DEFAULT {default}')
        except sqlite3.OperationalError:
            pass


def _create_indexes(cursor):
    for sql in [
        'CREATE INDEX IF NOT EXISTS idx_history_user_time ON conversation_history(user_number, timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_conversation_logs_timestamp ON conversation_logs(timestamp)',
        'CREATE INDEX IF NOT EXISTS idx_ai_system_items_type_status ON ai_system_items(item_type, status, updated_at)',
        'CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status)',
        'CREATE INDEX IF NOT EXISTS idx_orders_user_number ON orders(user_number)',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_public_order_id ON orders(public_order_id) WHERE public_order_id != ""',
        'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_idempotency ON orders(idempotency_key) WHERE idempotency_key != ""',
        'CREATE INDEX IF NOT EXISTS idx_payment_proofs_status ON payment_proofs(status)',
        'CREATE INDEX IF NOT EXISTS idx_payment_proofs_user_number ON payment_proofs(user_number)',
        'CREATE INDEX IF NOT EXISTS idx_payment_proofs_order_id ON payment_proofs(order_id)',
        'CREATE INDEX IF NOT EXISTS idx_shipping_rates_lookup ON shipping_rates(active, province, city, district)',
        'CREATE INDEX IF NOT EXISTS idx_shipping_rates_city ON shipping_rates(active, city)',
        'CREATE INDEX IF NOT EXISTS idx_closings_status_created ON closings(status, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_closings_source_created ON closings(source, created_at)',
        'CREATE INDEX IF NOT EXISTS idx_products_active ON products(active)',
        'CREATE INDEX IF NOT EXISTS idx_faqs_active ON faqs(active)',
        'CREATE INDEX IF NOT EXISTS idx_testimonials_active_sort ON testimonials(active, sort_order)',
        'CREATE INDEX IF NOT EXISTS idx_cs_templates_active ON cs_templates(active)',
    ]:
        cursor.execute(sql)


def _seed_defaults(cursor):
    defaults = default_settings(_telegram_bot_token)
    for key, value in defaults.items():
        cursor.execute('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)', (key, value))

    for key in ['company_name', 'llm_provider', 'llm_api_url', 'ai_model', 'ai_temperature', 'ai_max_tokens']:
        cursor.execute('UPDATE settings SET value=? WHERE key=? AND TRIM(value)=?', (defaults[key], key, ''))

    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    for item in DEFAULT_CS_TEMPLATES:
        existing = cursor.execute(
            'SELECT id FROM cs_templates WHERE LOWER(title) = LOWER(?) LIMIT 1',
            (item['title'],)
        ).fetchone()
        if not existing:
            cursor.execute("""
                INSERT INTO cs_templates
                    (title, content, active, created_at, updated_at)
                VALUES
                    (?, ?, 1, ?, ?)
            """, (item['title'], item['content'], now, now))


def _migrate_testimonials_from_faqs(cursor):
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    testimonial_rows = cursor.execute("""
        SELECT id, question, answer, image_url
        FROM faqs
        WHERE active = 1
          AND COALESCE(image_url, '') != ''
          AND (
            LOWER(question || ' ' || answer || ' ' || image_url) LIKE '%testimoni%'
            OR LOWER(question || ' ' || answer || ' ' || image_url) LIKE '%testimonial%'
            OR LOWER(question || ' ' || answer || ' ' || image_url) LIKE '%review%'
            OR LOWER(question || ' ' || answer || ' ' || image_url) LIKE '%ulasan%'
            OR LOWER(image_url) LIKE '%/testimoni/%'
          )
        ORDER BY id ASC
    """).fetchall()
    for index, row in enumerate(testimonial_rows, start=1):
        media_url = row['image_url'] or ''
        media_type = 'video' if media_url.lower().endswith(('.mp4', '.mov', '.webm')) else 'image'
        existing = cursor.execute(
            'SELECT id FROM testimonials WHERE media_url = ? LIMIT 1',
            (media_url,)
        ).fetchone()
        if existing:
            cursor.execute("""
                UPDATE testimonials
                SET title = ?, caption = ?, media_type = ?, active = 1, updated_at = ?
                WHERE id = ?
            """, (row['question'], row['answer'] or '', media_type, now, existing['id']))
        else:
            cursor.execute("""
                INSERT INTO testimonials
                    (title, caption, media_url, media_type, sort_order, active, created_at, updated_at)
                VALUES
                    (?, ?, ?, ?, ?, 1, ?, ?)
            """, (row['question'], row['answer'] or '', media_url, media_type, index, now, now))
        cursor.execute('UPDATE faqs SET active = 0 WHERE id = ?', (row['id'],))

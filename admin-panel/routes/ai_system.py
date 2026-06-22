"""AI System routes: memory, learning, skills, review, scoring, and handoff."""

from datetime import datetime, timedelta
import json
import re

from flask import Blueprint, current_app, jsonify, request

from admin_core.auth import login_required, require_internal_auth
from admin_core.db import get_db
from admin_core.helpers import normalize_wa_number, wa_number_variants
from routes.operations import _send_wa_message


ai_system_bp = Blueprint('ai_system', __name__)


DEFAULT_HANDOFF_SETTINGS = {
    'enable_risk_scoring': True,
    'enable_sensitive_keywords': True,
    'enable_follow_up': True,
    'medium_risk_enabled': True,
    'follow_up_days': 2,
    'idle_hours': 12,
    'min_chat_count': 2,
    'keywords': [
        'komplain', 'marah', 'kecewa', 'refund', 'retur', 'batal', 'cancel', 'penipuan',
        'diabetes', 'jantung', 'hamil', 'menyusui', 'obat dokter', 'dokter', 'alergi',
        'bpom', 'aman tidak', 'bahaya', 'efek samping', 'sakit', 'sembuh', 'jamin'
    ],
    'follow_up_keywords': [
        'mau pikir', 'nanti', 'besok', 'belum yakin', 'mahal', 'tanya suami', 'tanya istri',
        'belum ada uang', 'transfer nanti', 'cod nanti', 'minat', 'harga', 'promo'
    ],
}


def ensure_ai_system_tables():
    with get_db() as conn:
        c = conn.cursor()
        c.execute('''CREATE TABLE IF NOT EXISTS conversation_scores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id INTEGER UNIQUE,
            score INTEGER DEFAULT 0,
            relevance INTEGER DEFAULT 0,
            empathy INTEGER DEFAULT 0,
            safety INTEGER DEFAULT 0,
            closing INTEGER DEFAULT 0,
            risk_level TEXT DEFAULT 'low',
            issues TEXT DEFAULT '',
            recommendation TEXT DEFAULT '',
            reviewer_note TEXT DEFAULT '',
            status TEXT DEFAULT 'auto',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS learning_bank (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            title TEXT NOT NULL,
            category TEXT DEFAULT 'general',
            source_type TEXT DEFAULT 'manual',
            question_pattern TEXT DEFAULT '',
            answer_recommendation TEXT DEFAULT '',
            insight TEXT DEFAULT '',
            tags TEXT DEFAULT '',
            status TEXT DEFAULT 'draft',
            review_note TEXT DEFAULT '',
            reviewed_at TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS ai_skills (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            skill_key TEXT DEFAULT '',
            category TEXT DEFAULT 'general',
            description TEXT DEFAULT '',
            trigger_rules TEXT DEFAULT '',
            response_rules TEXT DEFAULT '',
            guardrails TEXT DEFAULT '',
            example_response TEXT DEFAULT '',
            priority INTEGER DEFAULT 50,
            active INTEGER DEFAULT 1,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP)''')
        c.execute('''CREATE TABLE IF NOT EXISTS human_handoffs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            log_id INTEGER UNIQUE,
            user_number TEXT DEFAULT '',
            priority TEXT DEFAULT 'medium',
            reason TEXT DEFAULT '',
            status TEXT DEFAULT 'open',
            owner TEXT DEFAULT '',
            customer_message TEXT DEFAULT '',
            ai_response TEXT DEFAULT '',
            notes TEXT DEFAULT '',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT '')''')
        for sql in [
            "ALTER TABLE learning_bank ADD COLUMN review_note TEXT DEFAULT ''",
            "ALTER TABLE learning_bank ADD COLUMN reviewed_at TEXT DEFAULT ''",
            "ALTER TABLE human_handoffs ADD COLUMN resolved_at TEXT DEFAULT ''",
        ]:
            try:
                c.execute(sql)
            except Exception:
                pass
        for sql in [
            'CREATE INDEX IF NOT EXISTS idx_learning_bank_status ON learning_bank(status, updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_ai_skills_active_priority ON ai_skills(active, priority)',
            'CREATE INDEX IF NOT EXISTS idx_scores_risk ON conversation_scores(risk_level, score)',
            'CREATE INDEX IF NOT EXISTS idx_handoffs_status ON human_handoffs(status, updated_at)',
            'CREATE INDEX IF NOT EXISTS idx_handoffs_user ON human_handoffs(user_number)',
        ]:
            c.execute(sql)


def setting_get(key):
    with get_db() as conn:
        row = conn.execute('SELECT value FROM settings WHERE key=?', (key,)).fetchone()
        return row['value'] if row else ''


def setting_set(key, value):
    with get_db() as conn:
        conn.execute('INSERT OR REPLACE INTO settings(key, value) VALUES (?, ?)', (key, value))


def auto_score_conversation(user_message, ai_response):
    text = f"{user_message or ''} {ai_response or ''}".lower()
    relevance, empathy, safety, closing = 80, 60, 80, 50
    issues = []
    if any(word in text for word in ['kak', 'saya pahami', 'baik kak', 'iya kak']):
        empathy += 20
    if any(word in text for word in ['harga', 'promo', 'order', 'pesan', 'paket']):
        closing += 25
    if any(word in text for word in ['bpom', 'diabetes', 'obat', 'dokter', 'aman', 'merokok']):
        safety += 5
    if any(word in text for word in ['sembuh', 'menyembuhkan', 'pasti sembuh', 'jamin sembuh']):
        safety -= 45
        issues.append('Potensi overclaim kesehatan')
    if len((ai_response or '').strip()) < 25:
        relevance -= 20
        issues.append('Respons terlalu pendek')
    if len((ai_response or '').strip()) > 900:
        relevance -= 10
        issues.append('Respons terlalu panjang')
    if not any(word in (ai_response or '').lower() for word in ['kak', 'baik', 'iya', 'terima kasih']):
        empathy -= 10
        issues.append('Nada empati kurang terasa')
    relevance = max(0, min(100, relevance))
    empathy = max(0, min(100, empathy))
    safety = max(0, min(100, safety))
    closing = max(0, min(100, closing))
    score = round((relevance * 0.35) + (empathy * 0.2) + (safety * 0.3) + (closing * 0.15))
    risk_level = 'high' if safety < 55 or score < 60 else ('medium' if safety < 75 or score < 75 else 'low')
    recommendation = 'Review manual disarankan.' if risk_level != 'low' else 'Respons cukup aman, tetap bisa ditingkatkan jika ada pola berulang.'
    return {'score': score, 'relevance': relevance, 'empathy': empathy, 'safety': safety, 'closing': closing, 'risk_level': risk_level, 'issues': '; '.join(issues), 'recommendation': recommendation}


def strip_number_label(value):
    return re.sub(r'\s*\([^)]*\)\s*$', '', str(value or '').strip())


def valid_display_wa(value):
    normalized = normalize_wa_number(strip_number_label(value))
    if normalized.startswith('62') and 10 <= len(normalized) <= 15:
        return normalized
    return ''


def build_order_phone_map(cursor):
    mapping = {}
    rows = cursor.execute('''SELECT user_number, phone, COUNT(*) AS count
                             FROM orders
                             WHERE IFNULL(user_number, '') != '' AND IFNULL(phone, '') != ''
                             GROUP BY user_number, phone
                             ORDER BY count DESC''').fetchall()
    for row in rows:
        raw = strip_number_label(row['user_number'])
        phone = valid_display_wa(row['phone'])
        if raw and phone and raw not in mapping:
            mapping[raw] = phone
    return mapping


def resolve_display_number(storage_number, phone_map):
    raw = strip_number_label(storage_number)
    return valid_display_wa(raw) or phone_map.get(raw, '')


def ensure_conversation_scores(limit=1000):
    ensure_ai_system_tables()
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        c = conn.cursor()
        rows = c.execute('''SELECT cl.id, cl.user_message, cl.ai_response
                            FROM conversation_logs cl
                            LEFT JOIN conversation_scores cs ON cs.log_id=cl.id
                            WHERE cs.id IS NULL
                            ORDER BY cl.id DESC LIMIT ?''', (limit,)).fetchall()
        for row in rows:
            auto = auto_score_conversation(row['user_message'], row['ai_response'])
            c.execute('''INSERT OR IGNORE INTO conversation_scores
                (log_id, score, relevance, empathy, safety, closing, risk_level, issues, recommendation, reviewer_note, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '', 'auto', ?, ?)''',
                (row['id'], auto['score'], auto['relevance'], auto['empathy'], auto['safety'], auto['closing'], auto['risk_level'], auto['issues'], auto['recommendation'], now, now))


@ai_system_bp.route('/api/ai-system/memory/customers', methods=['GET'])
@login_required
def memory_customers():
    limit = min(max(request.args.get('limit', 80, type=int), 1), 500)
    q = (request.args.get('q') or '').strip()
    pattern = f'%{q}%'
    params = []
    where = ''
    if q:
        where = 'WHERE n.user_number LIKE ? OR IFNULL(cp.profile_json, "") LIKE ? OR IFNULL(cp.summary, "") LIKE ?'
        params.extend([pattern, pattern, pattern])
    with get_db() as conn:
        c = conn.cursor()
        phone_map = build_order_phone_map(c)
        rows = c.execute(f'''
            WITH numbers AS (
              SELECT user_number FROM customer_profiles
              UNION SELECT user_number FROM conversation_history
              UNION SELECT user_number FROM conversation_logs
            )
            SELECT n.user_number,
                   cp.profile_json,
                   cp.summary,
                   cp.created_at,
                   cp.updated_at,
                   COUNT(ch.id) AS history_count,
                   MAX(ch.timestamp) AS last_chat_at
            FROM numbers n
            LEFT JOIN customer_profiles cp ON cp.user_number=n.user_number
            LEFT JOIN conversation_history ch ON ch.user_number=n.user_number
            {where}
            GROUP BY n.user_number
            ORDER BY COALESCE(cp.updated_at, last_chat_at, cp.created_at, '') DESC
            LIMIT ?
        ''', (*params, limit)).fetchall()
    customers = []
    for row in rows:
        storage_number = strip_number_label(row['user_number'])
        display_number = resolve_display_number(storage_number, phone_map)
        if not display_number:
            continue
        try:
            profile = json.loads(row['profile_json'] or '{}')
        except Exception:
            profile = {}
        customers.append({
            'user_number': storage_number,
            'display_number': display_number,
            'name': profile.get('name', ''),
            'complaint': profile.get('complaint') or profile.get('complaint_detail', ''),
            'follow_up_stage': profile.get('follow_up_stage') or profile.get('active_stage', ''),
            'summary': row['summary'] or '',
            'updated_at': row['updated_at'] or '',
            'created_at': row['created_at'] or '',
            'last_chat_at': row['last_chat_at'] or '',
            'history_count': row['history_count'] or 0,
            'profile_keys': sorted(profile.keys()),
        })
    return jsonify({'customers': customers, 'count': len(customers), 'total': len(customers)})


@ai_system_bp.route('/api/ai-system/learning-bank', methods=['GET', 'POST'])
@login_required
def learning_bank():
    ensure_ai_system_tables()
    if request.method == 'POST':
        data = request.json or {}
        title = (data.get('title') or '').strip()
        if not title:
            return jsonify({'success': False, 'error': 'Judul insight wajib diisi'}), 400
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        with get_db() as conn:
            cur = conn.execute('''INSERT INTO learning_bank
                (title, category, source_type, question_pattern, answer_recommendation, insight, tags, status, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (title, data.get('category') or 'general', data.get('source_type') or 'manual', data.get('question_pattern') or '', data.get('answer_recommendation') or '', data.get('insight') or '', data.get('tags') or '', data.get('status') or 'draft', now, now))
        return jsonify({'success': True, 'id': cur.lastrowid})
    status = (request.args.get('status') or '').strip()
    q = (request.args.get('q') or '').strip()
    limit = min(max(request.args.get('limit', 120, type=int), 1), 300)
    where, params = [], []
    if status:
        where.append('status=?'); params.append(status)
    else:
        where.append("status IN ('draft','pending')")
    if q:
        pat = f'%{q}%'; where.append('(title LIKE ? OR category LIKE ? OR question_pattern LIKE ? OR answer_recommendation LIKE ? OR insight LIKE ? OR tags LIKE ?)'); params.extend([pat]*6)
    sql_where = 'WHERE ' + ' AND '.join(where)
    with get_db() as conn:
        items = [dict(r) for r in conn.execute(f'SELECT * FROM learning_bank {sql_where} ORDER BY updated_at DESC, id DESC LIMIT ?', (*params, limit)).fetchall()]
        counts = {r['status']: r['count'] for r in conn.execute('SELECT status, COUNT(*) count FROM learning_bank GROUP BY status').fetchall()}
    return jsonify({'items': items, 'counts': counts, 'count': len(items)})


@ai_system_bp.route('/api/ai-system/learning-bank/<int:item_id>', methods=['PUT', 'DELETE'])
@login_required
def learning_bank_item(item_id):
    ensure_ai_system_tables()
    if request.method == 'DELETE':
        with get_db() as conn:
            conn.execute('DELETE FROM learning_bank WHERE id=?', (item_id,))
        return jsonify({'success': True})
    data = request.json or {}
    title = (data.get('title') or '').strip()
    if not title:
        return jsonify({'success': False, 'error': 'Judul insight wajib diisi'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        cur = conn.execute('''UPDATE learning_bank SET title=?, category=?, source_type=?, question_pattern=?, answer_recommendation=?, insight=?, tags=?, status=?, updated_at=? WHERE id=?''',
            (title, data.get('category') or 'general', data.get('source_type') or 'manual', data.get('question_pattern') or '', data.get('answer_recommendation') or '', data.get('insight') or '', data.get('tags') or '', data.get('status') or 'draft', now, item_id))
    return jsonify({'success': bool(cur.rowcount)})


@ai_system_bp.route('/api/ai-system/skills', methods=['GET', 'POST'])
@login_required
def skills():
    ensure_ai_system_tables()
    if request.method == 'POST':
        data = request.json or {}
        name = (data.get('name') or '').strip()
        if not name:
            return jsonify({'success': False, 'error': 'Nama skill wajib diisi'}), 400
        now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
        active = 1 if str(data.get('active', '1')).lower() not in ('0', 'false', 'no') else 0
        with get_db() as conn:
            cur = conn.execute('''INSERT INTO ai_skills
                (name, skill_key, category, description, trigger_rules, response_rules, guardrails, example_response, priority, active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)''',
                (name, data.get('skill_key') or '', data.get('category') or 'general', data.get('description') or '', data.get('trigger_rules') or '', data.get('response_rules') or '', data.get('guardrails') or '', data.get('example_response') or '', int(data.get('priority') or 50), active, now, now))
        return jsonify({'success': True, 'id': cur.lastrowid})
    q = (request.args.get('q') or '').strip(); active = (request.args.get('active') or '').strip()
    where, params = [], []
    if active in ('0', '1'):
        where.append('active=?'); params.append(int(active))
    if q:
        pat = f'%{q}%'; where.append('(name LIKE ? OR skill_key LIKE ? OR category LIKE ? OR description LIKE ? OR trigger_rules LIKE ?)'); params.extend([pat]*5)
    sql_where = 'WHERE ' + ' AND '.join(where) if where else ''
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute(f'SELECT * FROM ai_skills {sql_where} ORDER BY active DESC, priority ASC, updated_at DESC, id DESC', params).fetchall()]
        counts = {str(r['active']): r['count'] for r in conn.execute('SELECT active, COUNT(*) count FROM ai_skills GROUP BY active').fetchall()}
    return jsonify({'items': rows, 'skills': rows, 'counts': counts, 'count': len(rows)})


@ai_system_bp.route('/api/ai-system/skills/<int:skill_id>', methods=['PUT', 'DELETE'])
@login_required
def skill_item(skill_id):
    ensure_ai_system_tables()
    if request.method == 'DELETE':
        with get_db() as conn:
            conn.execute('DELETE FROM ai_skills WHERE id=?', (skill_id,))
        return jsonify({'success': True})
    data = request.json or {}; name = (data.get('name') or '').strip()
    if not name:
        return jsonify({'success': False, 'error': 'Nama skill wajib diisi'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    active = 1 if str(data.get('active', '1')).lower() not in ('0', 'false', 'no') else 0
    with get_db() as conn:
        cur = conn.execute('''UPDATE ai_skills SET name=?, skill_key=?, category=?, description=?, trigger_rules=?, response_rules=?, guardrails=?, example_response=?, priority=?, active=?, updated_at=? WHERE id=?''',
            (name, data.get('skill_key') or '', data.get('category') or 'general', data.get('description') or '', data.get('trigger_rules') or '', data.get('response_rules') or '', data.get('guardrails') or '', data.get('example_response') or '', int(data.get('priority') or 50), active, now, skill_id))
    return jsonify({'success': bool(cur.rowcount)})


@ai_system_bp.route('/api/ai-system/review-approval', methods=['GET'])
@login_required
def review_approval():
    ensure_ai_system_tables()
    status = (request.args.get('status') or 'pending').strip(); q = (request.args.get('q') or '').strip()
    where, params = [], []
    if status:
        where.append('status=?'); params.append(status)
    if q:
        pat = f'%{q}%'; where.append('(title LIKE ? OR category LIKE ? OR question_pattern LIKE ? OR answer_recommendation LIKE ? OR insight LIKE ? OR tags LIKE ?)'); params.extend([pat]*6)
    sql_where = 'WHERE ' + ' AND '.join(where) if where else ''
    with get_db() as conn:
        items = [dict(r) for r in conn.execute(f'SELECT * FROM learning_bank {sql_where} ORDER BY updated_at DESC, id DESC', params).fetchall()]
        counts = {r['status']: r['count'] for r in conn.execute('SELECT status, COUNT(*) count FROM learning_bank GROUP BY status').fetchall()}
    return jsonify({'items': items, 'counts': counts, 'count': len(items)})


@ai_system_bp.route('/api/ai-system/review-approval/<int:item_id>', methods=['PUT'])
@login_required
def review_approval_item(item_id):
    ensure_ai_system_tables()
    data = request.json or {}; status = (data.get('status') or '').strip()
    if status not in ('pending', 'approved', 'rejected'):
        return jsonify({'success': False, 'error': 'Status review tidak valid'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    reviewed_at = now if status in ('approved', 'rejected') else ''
    with get_db() as conn:
        cur = conn.execute('UPDATE learning_bank SET status=?, review_note=?, reviewed_at=?, updated_at=? WHERE id=?', (status, data.get('review_note') or '', reviewed_at, now, item_id))
    return jsonify({'success': bool(cur.rowcount)})


@ai_system_bp.route('/api/ai-system/conversation-scoring', methods=['GET'])
@login_required
def conversation_scoring():
    ensure_conversation_scores()
    risk = (request.args.get('risk') or '').strip(); q = (request.args.get('q') or '').strip()
    limit = min(max(request.args.get('limit', 120, type=int), 1), 300)
    where, params = [], []
    if risk:
        where.append('cs.risk_level=?'); params.append(risk)
    if q:
        pat = f'%{q}%'; where.append('(cl.user_number LIKE ? OR cl.user_message LIKE ? OR cl.ai_response LIKE ? OR IFNULL(cs.issues, "") LIKE ?)'); params.extend([pat]*4)
    sql_where = 'WHERE ' + ' AND '.join(where) if where else ''
    with get_db() as conn:
        items = [dict(r) for r in conn.execute(f'''SELECT cl.id AS log_id, cl.timestamp, cl.user_number, cl.user_message, cl.ai_response,
            cs.id AS score_id, cs.score, cs.relevance, cs.empathy, cs.safety, cs.closing, cs.risk_level, cs.issues, cs.recommendation, cs.reviewer_note, cs.status, cs.updated_at
            FROM conversation_logs cl LEFT JOIN conversation_scores cs ON cs.log_id=cl.id {sql_where} ORDER BY cl.id DESC LIMIT ?''', (*params, limit)).fetchall()]
        counts = {r['risk_level']: r['count'] for r in conn.execute('SELECT risk_level, COUNT(*) count FROM conversation_scores GROUP BY risk_level').fetchall()}
        total = conn.execute('SELECT COUNT(*) count FROM conversation_logs').fetchone()['count']
    return jsonify({'items': items, 'counts': counts, 'total_logs': total, 'count': len(items)})


@ai_system_bp.route('/api/ai-system/conversation-scoring/<int:log_id>', methods=['POST'])
@login_required
def save_conversation_score(log_id):
    ensure_ai_system_tables(); data = request.json or {}; now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        log = conn.execute('SELECT user_message, ai_response FROM conversation_logs WHERE id=?', (log_id,)).fetchone()
        if not log:
            return jsonify({'success': False, 'error': 'Conversation log tidak ditemukan'}), 404
        auto = auto_score_conversation(log['user_message'], log['ai_response'])
        values = {**auto, **{k: data[k] for k in data if k in auto}}
        conn.execute('''INSERT INTO conversation_scores (log_id, score, relevance, empathy, safety, closing, risk_level, issues, recommendation, reviewer_note, status, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(log_id) DO UPDATE SET score=excluded.score, relevance=excluded.relevance, empathy=excluded.empathy, safety=excluded.safety, closing=excluded.closing, risk_level=excluded.risk_level, issues=excluded.issues, recommendation=excluded.recommendation, reviewer_note=excluded.reviewer_note, status=excluded.status, updated_at=excluded.updated_at''',
            (log_id, values['score'], values['relevance'], values['empathy'], values['safety'], values['closing'], values['risk_level'], values['issues'], values['recommendation'], data.get('reviewer_note') or '', data.get('status') or 'reviewed', now, now))
    return jsonify({'success': True})


def get_handoff_settings():
    raw = setting_get('human_handoff_settings')
    data = {}
    if raw:
        try: data = json.loads(raw)
        except Exception: data = {}
    settings = dict(DEFAULT_HANDOFF_SETTINGS); settings.update(data if isinstance(data, dict) else {})
    settings['keywords'] = [str(x).strip().lower() for x in settings.get('keywords', []) if str(x).strip()]
    settings['follow_up_keywords'] = [str(x).strip().lower() for x in settings.get('follow_up_keywords', []) if str(x).strip()]
    for key in ['follow_up_days', 'idle_hours', 'min_chat_count']:
        settings[key] = max(1, int(settings.get(key) or DEFAULT_HANDOFF_SETTINGS[key]))
    return settings


def handoff_reason(user_message, ai_response, score, settings):
    text = f"{user_message or ''} {ai_response or ''}".lower()
    hits = [word for word in settings.get('keywords', []) if word in text]
    reasons = []
    if score.get('risk_level') == 'high': reasons.append('Risk tinggi dari Conversation Scoring')
    elif score.get('risk_level') == 'medium' and settings.get('medium_risk_enabled'): reasons.append('Risk medium perlu pantauan CS')
    if score.get('issues'): reasons.append(score['issues'])
    if hits: reasons.append('Keyword sensitif: ' + ', '.join(hits[:5]))
    return '; '.join(dict.fromkeys(reasons)) or 'Perlu review CS manusia'


def priority_from_reason(score, reason):
    text = (reason or '').lower()
    if score.get('risk_level') == 'high' or any(w in text for w in ['komplain', 'refund', 'bahaya', 'jantung', 'hamil']): return 'high'
    if score.get('risk_level') == 'medium' or any(w in text for w in ['diabetes', 'dokter', 'bpom', 'alergi']): return 'medium'
    return 'low'


def upsert_handoff(cursor, log_id, user_number, priority, reason, user_message, ai_response, now):
    normalized = normalize_wa_number(user_number)
    if not normalized: return 0
    existing = cursor.execute("SELECT id, priority, reason FROM human_handoffs WHERE user_number=? AND status IN ('open','in_progress') ORDER BY updated_at DESC, id DESC LIMIT 1", (normalized,)).fetchone()
    if existing:
        cursor.execute('UPDATE human_handoffs SET priority=?, reason=?, updated_at=? WHERE id=?', (priority, reason, now, existing['id']))
        return 0
    cursor.execute('''INSERT INTO human_handoffs (log_id, user_number, priority, reason, status, owner, customer_message, ai_response, notes, created_at, updated_at)
                      VALUES (?, ?, ?, ?, 'open', '', ?, ?, '', ?, ?)''', (log_id, normalized, priority, reason, user_message or '', ai_response or '', now, now))
    return cursor.rowcount


def ensure_handoff_candidates(limit=200):
    ensure_ai_system_tables(); settings = get_handoff_settings(); now = datetime.now().strftime('%Y-%m-%d %H:%M:%S'); inserted = 0
    with get_db() as conn:
        c = conn.cursor()
        rows = c.execute('SELECT id, user_number, user_message, ai_response FROM conversation_logs WHERE IFNULL(user_number, "") != "" ORDER BY id DESC LIMIT ?', (limit,)).fetchall()
        for row in rows:
            score = auto_score_conversation(row['user_message'], row['ai_response'])
            text = f"{row['user_message'] or ''} {row['ai_response'] or ''}".lower()
            keyword_hit = settings.get('enable_sensitive_keywords') and any(w in text for w in settings.get('keywords', []))
            risk_hit = settings.get('enable_risk_scoring') and (score['risk_level'] == 'high' or (settings.get('medium_risk_enabled') and score['risk_level'] == 'medium'))
            if not keyword_hit and not risk_hit: continue
            reason = handoff_reason(row['user_message'], row['ai_response'], score, settings)
            inserted += upsert_handoff(c, row['id'], row['user_number'], priority_from_reason(score, reason), reason, row['user_message'], row['ai_response'], now)
    return inserted


@ai_system_bp.route('/api/ai-system/human-handoff/settings', methods=['GET', 'POST'])
@login_required
def handoff_settings():
    ensure_ai_system_tables()
    if request.method == 'POST':
        data = request.json or {}; settings = get_handoff_settings()
        for key in ['enable_risk_scoring','enable_sensitive_keywords','enable_follow_up','medium_risk_enabled']:
            if key in data: settings[key] = bool(data.get(key))
        for key in ['follow_up_days','idle_hours','min_chat_count']:
            if key in data: settings[key] = max(1, int(data.get(key) or settings[key]))
        for key in ['keywords', 'follow_up_keywords']:
            if key in data:
                value = data[key]
                parts = re.split(r'[,\n]+', value) if isinstance(value, str) else value if isinstance(value, list) else []
                settings[key] = [str(x).strip().lower() for x in parts if str(x).strip()]
        setting_set('human_handoff_settings', json.dumps(settings, ensure_ascii=False))
        return jsonify({'success': True, 'settings': settings})
    return jsonify({'success': True, 'settings': get_handoff_settings()})


@ai_system_bp.route('/api/ai-system/human-handoff/refresh', methods=['POST'])
@login_required
def handoff_refresh():
    return jsonify({'success': True, 'inserted': ensure_handoff_candidates()})


@ai_system_bp.route('/api/ai-system/human-handoff/status/<user_number>', methods=['GET'])
@require_internal_auth
def handoff_status(user_number):
    ensure_ai_system_tables(); normalized = normalize_wa_number(user_number)
    with get_db() as conn:
        rows = [dict(r) for r in conn.execute("SELECT id, user_number, status, owner, notes, updated_at FROM human_handoffs WHERE status='in_progress' ORDER BY updated_at DESC, id DESC LIMIT 200").fetchall()]
    ticket = next((r for r in rows if normalize_wa_number(r.get('user_number')) == normalized), None)
    return jsonify({'success': True, 'paused': bool(ticket), 'ticket': ticket})


@ai_system_bp.route('/api/ai-system/human-handoff', methods=['GET'])
@login_required
def handoff_list():
    ensure_ai_system_tables()
    status = (request.args.get('status') or '').strip(); q = (request.args.get('q') or '').strip()
    where, params = [], []
    if status == 'archived': where.append("status IN ('archived','canceled')")
    elif status: where.append('status=?'); params.append(status)
    if q:
        pat = f'%{q}%'; where.append('(user_number LIKE ? OR reason LIKE ? OR customer_message LIKE ? OR ai_response LIKE ? OR owner LIKE ?)'); params.extend([pat]*5)
    sql_where = 'WHERE ' + ' AND '.join(where) if where else ''
    with get_db() as conn:
        items = [dict(r) for r in conn.execute(f'''SELECT id, log_id, user_number, priority, reason, status, owner, customer_message, ai_response, notes, created_at, updated_at, resolved_at FROM human_handoffs {sql_where}
            ORDER BY CASE priority WHEN 'high' THEN 1 WHEN 'medium' THEN 2 ELSE 3 END, updated_at DESC, id DESC LIMIT 160''', params).fetchall()]
        counts = {r['status']: r['count'] for r in conn.execute('SELECT status, COUNT(*) count FROM human_handoffs GROUP BY status').fetchall()}
        total = conn.execute('SELECT COUNT(*) count FROM human_handoffs').fetchone()['count']
    return jsonify({'success': True, 'items': items, 'counts': counts, 'total': total, 'count': len(items)})


@ai_system_bp.route('/api/ai-system/human-handoff/<int:ticket_id>', methods=['PUT'])
@login_required
def handoff_update(ticket_id):
    ensure_ai_system_tables(); data = request.json or {}; status = (data.get('status') or '').strip(); allowed = {'open','in_progress','resolved','canceled','archived'}
    if status and status not in allowed: return jsonify({'success': False, 'error': 'Status handoff tidak valid'}), 400
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S'); resolved_at = now if status in ('resolved','canceled','archived') else ''
    with get_db() as conn:
        cur = conn.execute('UPDATE human_handoffs SET status=COALESCE(NULLIF(?, ""), status), owner=?, notes=?, updated_at=?, resolved_at=? WHERE id=?', (status, data.get('owner') or '', data.get('notes') or '', now, resolved_at, ticket_id))
    return jsonify({'success': bool(cur.rowcount)})


@ai_system_bp.route('/api/ai-system/human-handoff/<int:ticket_id>/auto-reply', methods=['POST'])
@login_required
def handoff_auto_reply(ticket_id):
    ensure_ai_system_tables(); data = request.json or {}; message = (data.get('message') or '').strip()
    if not message: return jsonify({'success': False, 'error': 'Catatan Penanganan / Auto Balas wajib diisi'}), 400
    with get_db() as conn:
        ticket = conn.execute('SELECT * FROM human_handoffs WHERE id=?', (ticket_id,)).fetchone()
    if not ticket: return jsonify({'success': False, 'error': 'Ticket handoff tidak ditemukan'}), 404
    if ticket['status'] in ('resolved', 'canceled', 'archived'): return jsonify({'success': False, 'error': 'Ticket sudah selesai/archive'}), 400
    sent, error = _send_wa_message(ticket['user_number'], message)
    if not sent: return jsonify({'success': False, 'error': error}), 502
    now = datetime.now().strftime('%Y-%m-%d %H:%M:%S')
    with get_db() as conn:
        conn.execute('UPDATE human_handoffs SET notes=?, updated_at=? WHERE id=?', (message, now, ticket_id))
        conn.execute('INSERT INTO conversation_history (user_number, role, content, timestamp) VALUES (?, ?, ?, ?)', (normalize_wa_number(ticket['user_number']), 'assistant', message, now))
    return jsonify({'success': True})


def build_ai_system_knowledge_context():
    ensure_ai_system_tables(); lines = []
    with get_db() as conn:
        learning = conn.execute("SELECT * FROM learning_bank WHERE status='approved' ORDER BY reviewed_at DESC, updated_at DESC, id DESC LIMIT 12").fetchall()
        skills = conn.execute('SELECT * FROM ai_skills WHERE active=1 ORDER BY priority ASC, updated_at DESC, id DESC LIMIT 10').fetchall()
    if learning:
        lines.append('LEARNING BANK APPROVED:')
        for item in learning:
            lines.append(f"- {item['title']} [{item['category']}]")
            if item['question_pattern']: lines.append(f"  Pola: {item['question_pattern']}")
            if item['answer_recommendation']: lines.append(f"  Jawaban aman: {item['answer_recommendation']}")
            if item['insight']: lines.append(f"  Catatan: {item['insight']}")
    if skills:
        lines.append('\nSKILL SYSTEM AKTIF:')
        for skill in skills:
            lines.append(f"- {skill['name']} [{skill['category']} | priority {skill['priority']}]")
            if skill['trigger_rules']: lines.append(f"  Trigger: {skill['trigger_rules']}")
            if skill['response_rules']: lines.append(f"  Response: {skill['response_rules']}")
            if skill['guardrails']: lines.append(f"  Guardrails: {skill['guardrails']}")
    return '\n'.join(lines).strip()


@ai_system_bp.route('/api/ai-system/knowledge-context', methods=['GET'])
@require_internal_auth
def knowledge_context():
    return jsonify({'success': True, 'context': build_ai_system_knowledge_context()})

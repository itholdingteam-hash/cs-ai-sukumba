"""Consultation slot extraction helpers."""

import html
import re
from dataclasses import dataclass
from typing import Callable

from .patterns import CONSULT_QUESTION_IDS


@dataclass(frozen=True)
class ConsultationStateDeps:
    is_consultation_request: Callable
    has_male_health_signal: Callable
    has_general_health_signal: Callable
    is_consultation_context_continuation: Callable
    consultation_topic_from_context: Callable
    has_male_vitality_goal: Callable


def text_has_any_value(profile, keys):
    profile = profile if isinstance(profile, dict) else {}
    return any(profile.get(key) not in (None, '', [], {}) for key in keys)


def male_vitality_context(profile, history=None, has_male_vitality_signal_fn=None):
    profile = profile if isinstance(profile, dict) else {}
    profile_context_active = profile.get('active_flow') == 'consultation' or profile.get('last_question_id') in CONSULT_QUESTION_IDS
    if profile.get('consultation_topic') == 'male_vitality' and profile_context_active:
        return True
    haystack = ' '.join([
        str(profile.get('complaint', '') or ''),
        str(profile.get('complaint_detail', '') or ''),
        str(profile.get('consultation_goal', '') or ''),
        str(profile.get('summary', '') or ''),
    ])
    if profile_context_active and has_male_vitality_signal_fn and has_male_vitality_signal_fn(haystack):
        return True
    for item in (history or [])[-8:]:
        if has_male_vitality_signal_fn and has_male_vitality_signal_fn(item.get('content', '')):
            return True
        if item.get('role') == 'assistant' and re.search(r'vitalitas|ereksi|usia kakak.*keluhan|diabetes.*tensi.*jantung', item.get('content', ''), re.IGNORECASE):
            return True
    return False


def consultation_topic_from_context(
    raw_text,
    profile=None,
    history=None,
    has_male_vitality_signal_fn=None,
    has_male_vitality_goal_fn=None,
    has_general_stamina_signal_fn=None,
    has_general_health_signal_fn=None,
):
    profile = profile if isinstance(profile, dict) else {}
    if (
        (has_male_vitality_signal_fn and has_male_vitality_signal_fn(raw_text))
        or (has_male_vitality_goal_fn and has_male_vitality_goal_fn(raw_text))
        or male_vitality_context(profile, history, has_male_vitality_signal_fn)
    ):
        return 'male_vitality'
    if has_general_stamina_signal_fn and has_general_stamina_signal_fn(raw_text):
        return 'stamina_general'
    if has_general_health_signal_fn and has_general_health_signal_fn(raw_text):
        return 'general_health'
    return profile.get('consultation_topic', '')


def infer_yes_no(lower, positive_terms):
    negation = r'\b(tidak|nggak|gak|ga|bukan|belum|normal)\b'
    for term in positive_terms:
        if term in lower:
            window = lower[max(0, lower.find(term)-18):lower.find(term)+len(term)+18]
            return 'tidak' if re.search(negation, window) else 'ya'
    return None


def risk_factor_status(profile):
    profile = profile if isinstance(profile, dict) else {}
    return {
        'diabetes': profile.get('diabetes'),
        'hypertension': profile.get('hypertension'),
        'heart_issue': profile.get('heart_issue'),
        'medication': profile.get('medication'),
    }


def has_risk_factor_answer(profile):
    return text_has_any_value(profile, ['diabetes', 'hypertension', 'heart_issue', 'medication'])


def has_lifestyle_answer(profile):
    return text_has_any_value(profile, ['sleep', 'smoking', 'stress'])


def male_consult_next_step(profile):
    profile = profile if isinstance(profile, dict) else {}
    if not profile.get('age') or not profile.get('duration'):
        return 'age_duration', 'usia dan durasi keluhan'
    if not has_risk_factor_answer(profile):
        return 'risk_factors', 'riwayat diabetes, tensi, jantung, atau obat rutin'
    if not has_lifestyle_answer(profile):
        return 'lifestyle', 'pola tidur, rokok, dan stres'
    return 'education_offer', 'edukasi ringan dan rekomendasi produk'


def normalize_duration_unit(unit):
    unit = str(unit or '').lower()
    if unit in {'bulan', 'bulanan'}:
        unit = 'bulan'
    elif unit.endswith('an'):
        unit = unit[:-2]
    if unit in {'th', 'thn'}:
        return 'tahun'
    return unit


def extract_duration_value(raw_text):
    lower = html.unescape(str(raw_text or '')).lower()
    unit_pattern = r'hari|harian|minggu|mingguan|bulan|bulanan|tahun|tahunan|thn|th'
    marker_patterns = [
        rf'\b(?:sudah|udah|udh|dari|selama)\s+(?:sekitar|sktr|kurang\s+lebih\s+)?(\d{{1,2}})\s*({unit_pattern})\b',
        rf'\b(?:sekitar|sktr|kurang\s+lebih)\s+(\d{{1,2}})\s*({unit_pattern})\b',
    ]
    for pattern in marker_patterns:
        match = re.search(pattern, lower)
        if match:
            value = int(match.group(1))
            unit = normalize_duration_unit(match.group(2))
            if 1 <= value <= 60:
                return f"{value} {unit}"
    return ''


def extract_age_duration_slots(raw_text, profile=None, extract_blood_pressure_fn=None):
    profile = profile if isinstance(profile, dict) else {}
    lower = html.unescape(str(raw_text or '')).lower().strip()
    updates = {}
    if extract_blood_pressure_fn and extract_blood_pressure_fn(lower):
        return updates

    explicit_duration = extract_duration_value(lower)

    explicit_age = re.search(r'\b(?:umur|usia|usia\s+saya|saya)\s*(\d{2})\s*(?:tahun|th|thn)?\b', lower)
    age_val = None
    if explicit_age:
        age_val = int(explicit_age.group(1))
    else:
        nums = [
            int(n) for n in re.findall(
                r'(?<!/)\b(\d{2})(?:\s*(?:tahun|thn|th)\b|\b)(?!/)',
                lower
            )
        ]
        for n in nums:
            if 18 <= n <= 80:
                age_val = n
                break
    if age_val and 18 <= age_val <= 80:
        updates['age'] = str(age_val)

    if explicit_duration:
        updates['duration'] = explicit_duration
    else:
        duration = ''
        if not duration:
            matches = re.findall(r'\b(\d{1,2})\s*(hari|harian|minggu|mingguan|bulan|bulanan|tahun|tahunan|thn|th)\b', lower)
            age_candidate = updates.get('age') or profile.get('age')
            for raw_value, raw_unit in matches:
                value = int(raw_value)
                unit = normalize_duration_unit(raw_unit)
                if str(value) == str(age_candidate) and unit == 'tahun':
                    continue
                if unit == 'tahun' and value >= 18:
                    continue
                if 1 <= value <= 60:
                    duration = f"{value} {unit}"
                    break
        if duration:
            updates['duration'] = duration
    return updates


def is_negative_risk_answer(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    lower = re.sub(r'[.!?]+$', '', lower)
    lower = re.sub(r'\b(kak|ya|yah|sih|kok|nih|insya\s*allah|insyaallah|alhamdulillah)\b', '', lower)
    lower = re.sub(r'\s+', ' ', lower).strip()
    return bool(re.fullmatch(
        r'(tidak ada|tdk ada|gak ada|ga ada|nggak ada|ngga ada|enggak ada|'
        r'tidak|tdk|gak|ga|nggak|ngga|enggak|belum ada|aman|normal)',
        lower
    ))


def extract_risk_factor_slots(raw_text):
    lower = html.unescape(str(raw_text or '')).lower().strip()
    updates = {}
    if is_negative_risk_answer(raw_text):
        updates['diabetes'] = 'tidak'
        updates['hypertension'] = 'tidak'
        updates['heart_issue'] = 'tidak'
        updates['medication'] = 'tidak ada'
        return updates
    if re.search(r'\b(tensi|hipertensi|darah\s+tinggi)\b', lower):
        updates['hypertension'] = infer_yes_no(lower, ['hipertensi', 'darah tinggi', 'tensi']) or 'ya'
    if re.search(r'\b(diabetes|gula\s+darah|kencing\s+manis)\b', lower):
        updates['diabetes'] = infer_yes_no(lower, ['diabetes', 'gula darah', 'kencing manis']) or 'ya'
    if re.search(r'\b(jantung|nitrat|isosorbid)\b', lower):
        updates['heart_issue'] = infer_yes_no(lower, ['jantung', 'nitrat', 'isosorbid']) or 'ya'
    if re.search(r'\b(obat\s+rutin|minum\s+obat|obat\s+dokter)\b', lower):
        if re.search(r'\b(tidak|tdk|gak|ga|nggak|ngga|belum)\b.{0,12}\bobat\b|\bobat\b.{0,12}\b(tidak|tdk|gak|ga|nggak|ngga|belum)\b', lower):
            updates['medication'] = 'tidak ada'
        else:
            updates['medication'] = html.unescape(str(raw_text or ''))[:160]
    return updates


def extract_lifestyle_slots(raw_text):
    text = html.unescape(str(raw_text or ''))
    lower = text.lower().strip()
    updates = {}
    if is_negative_risk_answer(raw_text):
        updates['smoking'] = 'tidak'
        updates['stress'] = 'tidak'
        return updates
    if re.search(r'\b(begadang|kurang\s+tidur|susah\s+tidur|insomnia)\b', lower):
        updates['sleep'] = text[:160]
    elif re.search(r'\b(pola\s+tidur|tidur)\b', lower):
        if re.search(r'\b(aman|normal|cukup|teratur|baik|bagus)\b', lower):
            updates['sleep'] = 'aman/normal'
        elif re.search(r'\b(tidak|tdk|gak|ga|nggak|ngga)\b.{0,12}\b(aman|normal|baik|teratur)\b', lower):
            updates['sleep'] = text[:160]
        else:
            updates['sleep'] = text[:160]

    smoking = infer_yes_no(lower, ['rokok', 'merokok', 'perokok'])
    if smoking:
        updates['smoking'] = smoking

    if re.search(r'\b(stres|stress|banyak\s+pikiran|tekanan\s+kerja)\b', lower):
        if re.search(r'\b(tidak|tdk|gak|ga|nggak|ngga)\b.{0,12}\b(stres|stress)\b|\b(stres|stress)\b.{0,12}\b(aman|normal|tidak|tdk|gak|ga|nggak|ngga)\b', lower):
            updates['stress'] = 'tidak'
        else:
            updates['stress'] = text[:160]
    return updates


def extract_state_slot_updates(raw_text, profile=None, history=None, build_conversation_state_fn=None, extract_blood_pressure_fn=None):
    profile = profile if isinstance(profile, dict) else {}
    history = history or []
    state = build_conversation_state_fn(profile, history) if build_conversation_state_fn else {}
    updates = {}

    if state.get('last_question_id') == 'ask_age_duration' or state.get('pending_slot') == 'age_duration':
        updates.update(extract_age_duration_slots(raw_text, profile, extract_blood_pressure_fn))

    if state.get('last_question_id') == 'ask_risk_factors' or state.get('pending_slot') == 'risk_factors':
        updates.update(extract_risk_factor_slots(raw_text))

    if state.get('last_question_id') == 'ask_lifestyle' or state.get('pending_slot') == 'lifestyle':
        updates.update(extract_lifestyle_slots(raw_text))

    return updates


def recover_consultation_slots_from_history(
    history,
    profile=None,
    infer_question_id_from_reply_fn=None,
    consultation_topic_from_context_fn=None,
    has_male_health_signal_fn=None,
    has_male_vitality_goal_fn=None,
    extract_blood_pressure_fn=None,
):
    recovered = dict(profile if isinstance(profile, dict) else {})
    last_question_id = 'none'
    for item in history or []:
        role = item.get('role')
        content = item.get('content', '')
        if role == 'assistant':
            qid = infer_question_id_from_reply_fn(content) if infer_question_id_from_reply_fn else 'none'
            if qid != 'none':
                last_question_id = qid
            continue
        if role != 'user':
            continue
        if last_question_id == 'ask_age_duration':
            recovered.update(extract_age_duration_slots(content, recovered, extract_blood_pressure_fn))
        elif last_question_id == 'ask_risk_factors':
            recovered.update(extract_risk_factor_slots(content))
        elif last_question_id == 'ask_lifestyle':
            recovered.update(extract_lifestyle_slots(content))
        elif (
            (has_male_health_signal_fn and has_male_health_signal_fn(content))
            or (has_male_vitality_goal_fn and has_male_vitality_goal_fn(content))
        ):
            if consultation_topic_from_context_fn:
                recovered.setdefault('consultation_topic', consultation_topic_from_context_fn(content, recovered, history))
        recovered.update(extract_age_duration_slots(content, recovered, extract_blood_pressure_fn))
    return recovered


def merge_transient_profile(
    profile,
    raw_text,
    intent='male_health',
    history=None,
    extract_memory_updates_fn=None,
    build_conversation_state_fn=None,
    infer_question_id_from_reply_fn=None,
    consultation_topic_from_context_fn=None,
    has_male_health_signal_fn=None,
    has_male_vitality_goal_fn=None,
    extract_blood_pressure_fn=None,
):
    merged = dict(profile if isinstance(profile, dict) else {})
    if intent == 'male_health':
        merged.update(recover_consultation_slots_from_history(
            (history or [])[-14:],
            merged,
            infer_question_id_from_reply_fn=infer_question_id_from_reply_fn,
            consultation_topic_from_context_fn=consultation_topic_from_context_fn,
            has_male_health_signal_fn=has_male_health_signal_fn,
            has_male_vitality_goal_fn=has_male_vitality_goal_fn,
            extract_blood_pressure_fn=extract_blood_pressure_fn,
        ))
    parsed = extract_memory_updates_fn(raw_text, intent) if extract_memory_updates_fn else {}
    slot_updates = extract_state_slot_updates(
        raw_text,
        merged,
        history,
        build_conversation_state_fn=build_conversation_state_fn,
        extract_blood_pressure_fn=extract_blood_pressure_fn,
    )
    if slot_updates:
        parsed.update(slot_updates)
    merged.update(parsed)
    return merged


def enrich_consultation_state(profile, updates, raw_text, intent, deps):
    updates = dict(updates or {})
    profile = profile if isinstance(profile, dict) else {}
    lower = html.unescape(str(raw_text or '')).lower()
    should_track = (
        intent == 'male_health'
        or deps.is_consultation_request(lower)
        or deps.has_male_health_signal(lower)
        or deps.has_general_health_signal(lower)
        or (
            profile.get('active_flow') == 'consultation'
            and profile.get('last_question_id') in CONSULT_QUESTION_IDS
            and deps.is_consultation_context_continuation(lower, profile)
        )
    )
    if not should_track:
        return updates

    merged = dict(profile)
    merged.update(updates)
    topic = deps.consultation_topic_from_context(raw_text, merged)
    updates['conversation_mode'] = 'consultation'
    if topic:
        updates['consultation_topic'] = topic
    if deps.has_male_vitality_goal(raw_text):
        updates['consultation_goal'] = 'ingin stamina/vitalitas lebih prima'

    if topic == 'male_vitality':
        stage, next_question = male_consult_next_step(merged)
        updates['consultation_stage'] = stage
        updates['next_question'] = next_question
        asked = set(filter(None, re.split(r'\s*,\s*', str(profile.get('asked_questions', '') or ''))))
        if profile.get('age') or updates.get('age') or profile.get('duration') or updates.get('duration'):
            asked.add('age_duration')
        if has_risk_factor_answer(merged):
            asked.add('risk_factors')
        if has_lifestyle_answer(merged):
            asked.add('lifestyle')
        if asked:
            updates['asked_questions'] = ','.join(sorted(asked))
    elif topic in {'general_health', 'stamina_general'}:
        updates.setdefault('consultation_stage', 'clarifying_complaint')
        updates.setdefault('next_question', 'keluhan utama, durasi, dan pemicu')
    return updates

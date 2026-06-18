"""Conversation state precheck router.

This module handles deterministic state continuations before the LLM/orchestrator
falls through to intent routing.
"""

import re
from dataclasses import dataclass
from typing import Callable

from .patterns import CONSULT_QUESTION_IDS


@dataclass(frozen=True)
class StateRouterDeps:
    compact_user_text: Callable
    build_conversation_state: Callable
    is_identity_question: Callable
    is_name_question: Callable
    is_clear_closing: Callable
    is_short_product_request: Callable
    deterministic_product_reply: Callable
    product_context_updates: Callable
    is_short_purchase_request: Callable
    last_assistant_has_product_context: Callable
    deterministic_order_reply: Callable
    template_order_form: Callable
    is_package_choice_request: Callable
    is_package_recommendation_request: Callable
    package_recommendation_reply: Callable
    package_choice_reply: Callable
    order_prefill_for_choice: Callable
    is_product_context_active: Callable
    is_explicit_order_request: Callable
    is_product_question: Callable
    is_product_positive_reaction: Callable
    is_short_contextual_reply: Callable
    product_reaction_reply: Callable
    is_consultation_request: Callable
    has_male_health_signal: Callable
    has_general_health_signal: Callable
    triage_choice_reply: Callable
    is_followup_reaction: Callable


def route_state_precheck(msg, history, cfg=None, profile=None, knowledge_context='', deps=None):
    if deps is None:
        raise ValueError("StateRouterDeps is required")

    lower = deps.compact_user_text(msg)
    state = deps.build_conversation_state(profile, history)
    if not lower:
        return None
    if deps.is_identity_question(lower) or deps.is_name_question(lower) or deps.is_clear_closing(lower):
        return None
    if deps.is_short_product_request(lower):
        return (
            deps.deterministic_product_reply(msg, profile, history),
            'product_info',
            'state_product_shortcut',
            {'profile_updates': deps.product_context_updates('high')}
        )

    if deps.is_short_purchase_request(lower) and (
        state.get('active_flow') in {'product', 'post_order'}
        or deps.last_assistant_has_product_context(history)
    ):
        return (
            deps.deterministic_order_reply(msg, profile, history),
            'order',
            'state_order_shortcut',
            {'start_order': True, 'profile_updates': {
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }}
        )

    if state.get('pending_slot') == 'payment_method' and re.search(r'\b(cod|tf|transfer)\b', lower):
        method = 'COD' if re.search(r'\bcod\b|bayar\s+di\s+tempat', lower) else 'transfer'
        return (
            deps.template_order_form(f"Siap Kak, pembayarannya {method} ya. Boleh lengkapi form order berikut."),
            'order',
            'state_payment_method',
            {'start_order': True, 'order_prefill': {'payment': method}, 'profile_updates': {
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }}
        )

    if state.get('pending_slot') == 'package_choice' and deps.is_package_choice_request(lower):
        return (
            deps.package_choice_reply(msg, default_payment='cod'),
            'order',
            'state_package_choice_cod',
            {'start_order': True, 'order_prefill': deps.order_prefill_for_choice(msg, 'COD'), 'profile_updates': {
                'active_flow': 'order',
                'active_stage': 'awaiting_order_form',
                'last_question_id': 'ask_order_form',
                'pending_slot': 'order_form',
                'last_offer_type': 'order_form',
                'state_confidence': 'high',
            }}
        )

    if state.get('pending_slot') == 'package_choice' and lower in {'boleh', 'boleh kak', 'ok', 'oke', 'iya', 'ya', 'lanjut', 'siap'}:
        return (
            deps.package_recommendation_reply(msg, profile, history),
            'product_info',
            'state_package_recommendation_accept',
            {'profile_updates': {
                'active_flow': 'product',
                'active_stage': 'recommending_package',
                'last_question_id': 'ask_package_choice',
                'pending_slot': 'package_choice',
                'last_offer_type': 'order',
                'state_confidence': 'high',
            }}
        )

    if deps.is_package_recommendation_request(lower):
        return (
            deps.package_recommendation_reply(msg, profile, history),
            'product_info',
            'state_package_recommendation',
            {'profile_updates': {
                'active_flow': 'product',
                'active_stage': 'recommending_package',
                'last_question_id': 'ask_package_choice',
                'pending_slot': 'package_choice',
                'last_offer_type': 'order',
                'state_confidence': 'high',
            }}
        )

    if deps.is_product_context_active(state, history, profile):
        if deps.is_package_choice_request(lower):
            starts_order = bool(re.search(r'\b(cod|tf|transfer)\b', lower))
            payment = 'COD' if re.search(r'\bcod\b', lower) else ('TRF' if re.search(r'\b(tf|transfer)\b', lower) else '')
            return (
                deps.package_choice_reply(msg),
                'order',
                'state_package_choice',
                {'start_order': starts_order, 'order_prefill': deps.order_prefill_for_choice(msg, payment), 'profile_updates': {
                    'active_flow': 'order',
                    'active_stage': 'awaiting_order_form',
                    'last_question_id': 'ask_order_form',
                    'pending_slot': 'order_form',
                    'last_offer_type': 'order_form',
                    'state_confidence': 'high',
                }}
            )
        if deps.is_explicit_order_request(lower):
            return (
                deps.deterministic_order_reply(msg, profile, history),
                'order',
                'state_order_shortcut',
                {'start_order': True, 'profile_updates': {
                    'active_flow': 'order',
                    'active_stage': 'awaiting_order_form',
                    'last_question_id': 'ask_order_form',
                    'pending_slot': 'order_form',
                    'last_offer_type': 'order_form',
                    'state_confidence': 'high',
                }}
            )
        if deps.is_product_question(lower):
            return (
                deps.deterministic_product_reply(msg, profile, history),
                'product_info',
                'state_product_followup',
                {'profile_updates': deps.product_context_updates('high')}
            )
        if deps.is_product_positive_reaction(lower) or deps.is_short_contextual_reply(lower):
            return (
                deps.product_reaction_reply(),
                'product_info',
                'state_product_reaction',
                {'profile_updates': deps.product_context_updates('high')}
            )

    if (
        deps.is_consultation_request(lower)
        or deps.has_male_health_signal(lower)
        or deps.has_general_health_signal(lower)
        or deps.is_product_question(lower)
        or deps.is_explicit_order_request(lower)
    ):
        return None
    if lower in {'produk', 'info produk', 'tanya produk'}:
        return None

    if deps.is_short_contextual_reply(lower):
        question_id = state.get('last_question_id')
        active_flow = state.get('active_flow')
        if question_id == 'post_order_complete' or active_flow == 'post_order':
            return (
                "Siap Kak, terima kasih. Tim kami akan segera menghubungi untuk pesanan Kakak.",
                'post_order',
                'post_order_ack_agent',
                {'profile_updates': {
                    'active_flow': 'post_order',
                    'active_stage': 'completed',
                    'last_question_id': 'post_order_complete',
                    'pending_slot': 'none',
                    'last_offer_type': 'none',
                    'state_confidence': 'high',
                }}
            )
        if question_id == 'choose_product_or_consult':
            return (
                deps.triage_choice_reply(),
                'conversation',
                'state_clarifier',
                {'profile_updates': {
                    'active_flow': 'triage',
                    'active_stage': 'awaiting_choice',
                    'last_question_id': 'choose_product_or_consult',
                    'pending_slot': 'conversation_choice',
                    'last_offer_type': 'choice',
                    'state_confidence': 'high',
                }}
            )
        if question_id == 'ask_product_info' or active_flow == 'product':
            return (
                deps.product_reaction_reply(),
                'product_info',
                'state_product_followup',
                {'profile_updates': deps.product_context_updates('high')}
            )
        if question_id in CONSULT_QUESTION_IDS or active_flow == 'consultation':
            return None
        if question_id.startswith('ask_order_') or state.get('last_offer_type') == 'order':
            return None
        if deps.is_followup_reaction(lower):
            return (
                "Iya Kak. Saya CS Sukumba. Kakak mau info produk atau konsultasi dulu?",
                'conversation',
                'state_clarifier',
                {'profile_updates': {
                    'active_flow': 'triage',
                    'active_stage': 'awaiting_choice',
                    'last_question_id': 'choose_product_or_consult',
                    'pending_slot': 'conversation_choice',
                    'last_offer_type': 'choice',
                    'state_confidence': 'medium',
                }}
            )
        return (
            deps.triage_choice_reply(),
            'conversation',
            'state_clarifier',
            {'profile_updates': {
                'active_flow': 'triage',
                'active_stage': 'awaiting_choice',
                'last_question_id': 'choose_product_or_consult',
                'pending_slot': 'conversation_choice',
                'last_offer_type': 'choice',
                'state_confidence': 'medium',
            }}
        )
    return None

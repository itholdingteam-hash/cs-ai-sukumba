"""Input sanitization and prompt-injection filtering."""

import html
import re


INJECTION_PATTERNS = [
    r'ignore\s+(all\s+)?previous\s+(instructions?|prompts?)',
    r'forget\s+(everything|all)\s+(you\s+)?(know|learned)',
    r'you\s+are\s+now\s+',
    r'system\s*:\s*',
    r'user\s*:\s*assistant\s*:',
    r'<<<\s*SYS\s*>>>',
    r'\[system\s*override\]',
    r'ignore\s+above',
    r'disregard\s+all',
    r'new\s+instructions?:',
    r'prompt\s*:',
    r'you\s+are\s+a\s+helpful',
    r'act\s+as\s+',
]


def sanitize_input(text, logger=None, max_length=2000):
    """Sanitize customer text before it is sent to the LLM."""
    if not isinstance(text, str):
        text = str(text)

    text = html.escape(text[:max_length])
    for pattern in INJECTION_PATTERNS:
        if re.search(pattern, text, re.IGNORECASE):
            if logger:
                logger.warning(f"Prompt injection detected: {pattern}")
            text = re.sub(pattern, '[removed]', text, flags=re.IGNORECASE)

    return text

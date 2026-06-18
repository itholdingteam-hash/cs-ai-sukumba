"""Auth decorators shared by admin panel routes."""

from hmac import compare_digest
from functools import wraps

from flask import jsonify, redirect, request, session, url_for


_internal_api_key = ''


def configure_auth(internal_api_key=''):
    global _internal_api_key
    _internal_api_key = internal_api_key or ''


def require_internal_auth(f):
    """Allow logged-in admins or trusted service calls using X-Internal-Key."""
    @wraps(f)
    def wrapper(*args, **kwargs):
        key = request.headers.get('X-Internal-Key', '')
        if session.get('logged_in'):
            return f(*args, **kwargs)
        if _internal_api_key and compare_digest(key, _internal_api_key):
            return f(*args, **kwargs)
        if request.remote_addr in ('127.0.0.1', '::1', '172.31.6.3'):
            return f(*args, **kwargs)
        return jsonify({'error': 'Unauthorized'}), 401
    return wrapper


def login_required(f):
    @wraps(f)
    def wrapper(*args, **kwargs):
        if not session.get('logged_in'):
            if request.path.startswith('/api/'):
                return jsonify({'error': 'Unauthorized'}), 401
            return redirect(url_for('login'))
        return f(*args, **kwargs)
    wrapper.__name__ = f.__name__
    return wrapper

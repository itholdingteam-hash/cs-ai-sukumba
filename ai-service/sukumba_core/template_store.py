"""Cached loader for dynamic CS templates from the admin panel."""

import threading
import time

import requests


class DynamicTemplateStore:
    def __init__(self, api_url, internal_api_key='', logger=None, ttl_seconds=60):
        self.api_url = api_url
        self.internal_api_key = internal_api_key
        self.logger = logger
        self.ttl_seconds = ttl_seconds
        self._cache = {}
        self._last_fetch = 0
        self._lock = threading.Lock()

    def all(self):
        now = time.time()
        with self._lock:
            if now - self._last_fetch <= self.ttl_seconds:
                return self._cache

            self._last_fetch = now
            try:
                headers = {'X-Internal-Key': self.internal_api_key} if self.internal_api_key else {}
                response = requests.get(self.api_url, timeout=5, headers=headers)
                if response.ok:
                    data = response.json()
                    self._cache = {
                        item['title'].lower(): item['content']
                        for item in data
                        if item.get('active', 1) == 1
                    }
            except Exception as exc:
                if self.logger:
                    self.logger.warning(f"Failed to fetch dynamic CS templates: {exc}")

            return self._cache

    def get(self, title_key, default_text=None):
        return self.all().get(str(title_key).lower(), default_text)

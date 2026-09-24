import json
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server
from topic_store import TopicStore


class TopicsTest(unittest.TestCase):
    def test_concurrent_imports_persist_without_lost_updates(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'topics-custom.json'
            store = TopicStore(path)
            with ThreadPoolExecutor(max_workers=8) as pool:
                list(pool.map(lambda i: store.add({'category': '创作', 'group': '灵感',
                                                 'topics': ['共同选题', f'选题 {i}']}), range(20)))
            saved = TopicStore(path).read()['categories'][0]['groups'][0]['topics']
            self.assertEqual(len(saved), 21)
            self.assertEqual(path.stat().st_mode & 0o777, 0o600)
            before = path.read_bytes()
            with self.assertRaises(ValueError):
                store.add({'topics': ['正常', ' ' ]})
            self.assertEqual(path.read_bytes(), before)

    def test_http_roundtrip_preserves_original_and_rejects_bad_payload(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(server, 'DATA_ROOT', Path(tmp)):
            seed = Path(tmp) / 'topics-data.js'
            seed.write_text('window.WORKBENCH_TOPICS = {categories: []};')
            before = seed.read_bytes()
            http = server.ThreadingHTTPServer(('127.0.0.1', 0), server.WorkbenchHandler)
            thread = threading.Thread(target=http.serve_forever, daemon=True)
            thread.start()
            url = f'http://127.0.0.1:{http.server_port}/api/topics'
            def post(payload):
                return urlopen(Request(url, data=json.dumps(payload).encode(),
                                       headers={'Content-Type': 'application/json'}))
            try:
                with post({'topics': ['新选题', '新选题', '另一条']}) as r:
                    result = json.load(r)
                self.assertEqual((result['added'], result['skipped']), (2, 1))
                with urlopen(url) as r:
                    self.assertEqual(len(json.load(r)['categories'][0]['groups'][0]['topics']), 2)
                with self.assertRaises(HTTPError) as error:
                    post({'topics': ['x'] * 201})
                self.assertEqual(error.exception.code, 400)
                error.exception.close()
                self.assertEqual(seed.read_bytes(), before)
            finally:
                http.shutdown(); thread.join(); http.server_close()

    def test_corrupt_store_is_not_silently_overwritten(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / 'topics-custom.json'
            path.write_text('{broken')
            with self.assertRaises(ValueError):
                TopicStore(path).add({'topics': ['new']})
            self.assertEqual(path.read_text(), '{broken')

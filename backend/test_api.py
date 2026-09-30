"""Smoke tests for the public SignBridge API and frontend shell."""

from __future__ import annotations

import unittest

from fastapi.testclient import TestClient

from backend.server import app


class ApiTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.client = TestClient(app)
        cls.client.__enter__()

    @classmethod
    def tearDownClass(cls) -> None:
        cls.client.__exit__(None, None, None)

    # ── Health / readiness ──────────────────────────────────────────────

    def test_health_reports_runtime_information(self):
        response = self.client.get("/api/v1/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertIn("recognition_mode", payload)
        self.assertIn("version", payload)
        self.assertIn("timestamp", payload)
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

    def test_health_legacy_route_still_works(self):
        response = self.client.get("/health")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ok")

    def test_readiness_endpoint(self):
        response = self.client.get("/api/v1/ready")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "ready")

    def test_security_headers_are_present(self):
        response = self.client.get("/api/v1/health")
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")
        self.assertEqual(response.headers["x-frame-options"], "DENY")
        self.assertIn("content-security-policy", response.headers)
        self.assertIn("referrer-policy", response.headers)
        self.assertIn("permissions-policy", response.headers)

    # ── Translation ─────────────────────────────────────────────────────

    def test_translation_returns_an_inspectable_plan(self):
        response = self.client.post("/api/v1/translate", json={"text": "hello water", "lang": "en"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["coverage"], 100)
        self.assertEqual(payload["glosses"], ["HELLO", "WATER"])
        self.assertTrue(payload["sequence"])

    def test_translation_rejects_blank_input(self):
        response = self.client.post("/api/v1/translate", json={"text": "   "})
        self.assertEqual(response.status_code, 422)

    def test_translation_rejects_unexpected_fields(self):
        response = self.client.post(
            "/api/v1/translate",
            json={"text": "hello", "lang": "en", "unexpected": True},
        )
        self.assertEqual(response.status_code, 422)

    def test_translation_russian_text(self):
        response = self.client.post("/api/v1/translate", json={"text": "привет", "lang": "ru"})
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["language"], "ru")
        self.assertIn("HELLO", payload["glosses"])

    # ── Vocabulary ──────────────────────────────────────────────────────

    def test_vocabulary_endpoint_returns_lexicon_info(self):
        response = self.client.get("/api/v1/vocabulary")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertIn("gesture_count", payload)
        self.assertIn("languages", payload)
        self.assertGreater(payload["gesture_count"], 0)

    # ── Clear word ──────────────────────────────────────────────────────

    def test_clear_word_endpoint(self):
        response = self.client.post("/api/v1/clear-word")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["status"], "cleared")

    # ── WebSocket ───────────────────────────────────────────────────────

    def test_gesture_websocket_answers_ping(self):
        with self.client.websocket_connect("/ws/gesture") as websocket:
            websocket.send_json({"type": "ping"})
            self.assertEqual(websocket.receive_json(), {"type": "pong"})

    def test_gesture_websocket_reports_invalid_json(self):
        with self.client.websocket_connect("/ws/gesture") as websocket:
            websocket.send_text("not-json")
            payload = websocket.receive_json()
            self.assertEqual(payload["type"], "error")
            self.assertEqual(payload["code"], "invalid_json")

    def test_gesture_websocket_reports_non_object_message(self):
        with self.client.websocket_connect("/ws/gesture") as websocket:
            websocket.send_text('"just a string"')
            payload = websocket.receive_json()
            self.assertEqual(payload["type"], "error")
            self.assertEqual(payload["code"], "invalid_message")

    def test_gesture_websocket_reports_missing_frame(self):
        with self.client.websocket_connect("/ws/gesture") as websocket:
            websocket.send_json({"type": "frame"})
            payload = websocket.receive_json()
            self.assertEqual(payload["type"], "error")
            self.assertEqual(payload["code"], "missing_frame")

    def test_gesture_websocket_clear_command(self):
        with self.client.websocket_connect("/ws/gesture") as websocket:
            websocket.send_json({"type": "clear"})
            self.assertEqual(websocket.receive_json(), {"type": "cleared"})

    # ── Frontend static assets ──────────────────────────────────────────

    def test_frontend_manifest_is_served(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertIn("SignBridge", response.text)

    def test_frontend_index_is_served(self):
        response = self.client.get("/")
        self.assertEqual(response.status_code, 200)
        self.assertIn("SignBridge", response.text)


if __name__ == "__main__":
    unittest.main()

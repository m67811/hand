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

    def test_health_reports_runtime_information(self):
        response = self.client.get("/api/v1/health")
        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["status"], "ok")
        self.assertIn("recognition_mode", payload)
        self.assertEqual(response.headers["x-content-type-options"], "nosniff")

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

    def test_frontend_manifest_is_served(self):
        response = self.client.get("/manifest.webmanifest")
        self.assertEqual(response.status_code, 200)
        self.assertIn("SignBridge", response.text)


if __name__ == "__main__":
    unittest.main()

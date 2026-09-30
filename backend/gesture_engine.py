"""
SignBridge - Gesture Recognition Engine (MediaPipe Tasks API)
Uses HandLandmarker from mediapipe.tasks for hand keypoint extraction.
Supports both rule-based and ML-based gesture classification.
"""

import cv2
import numpy as np
import pickle
import os
import time
from collections import deque

try:
    import mediapipe as mp
    from mediapipe.tasks import python as mp_python
    from mediapipe.tasks.python import vision as mp_vision
except ImportError:
    # MediaPipe is optional: the engine has an OpenCV-only fallback mode.
    mp = None
    mp_python = None
    mp_vision = None

# ──────────────────────────────────────────────────────────────────────────────
# Constants
# ──────────────────────────────────────────────────────────────────────────────

# Base path for model files
MODEL_DIR = os.path.join(os.path.dirname(__file__), '..', 'models')
HAND_LANDMARKER_MODEL = os.path.join(MODEL_DIR, 'hand_landmarker.task')

# Dynamic gesture vocabulary
DYNAMIC_GESTURES = {
    'wave':        'Hello / Привет / Salom',
    'thumbs_up':   'Good / Хорошо / Yaxshi',
    'thumbs_down': 'Bad / Плохо / Yomon',
    'open_palm':   'Stop / Стоп / To\'xta',
    'fist':        'No / Нет / Yo\'q',
    'peace':       'Peace / Мир / Tinchlik',
    'point_up':    'Yes / Да / Ha',
    'ok_sign':     'OK / Окей / OK',
    'pinched':     'What? / Что? / Nima?',
    'call_me':     'Call me / Позвони / Qo\'ng\'iroq qil',
}

# Hand connection pairs for drawing (21 landmarks)
HAND_CONNECTIONS = [
    (0, 1), (1, 2), (2, 3), (3, 4),          # Thumb
    (0, 5), (5, 6), (6, 7), (7, 8),           # Index
    (9, 10), (10, 11), (11, 12),              # Middle
    (13, 14), (14, 15), (15, 16),             # Ring
    (0, 17), (17, 18), (18, 19), (19, 20),   # Pinky
    (5, 9), (9, 13), (13, 17),               # Palm
]


# ──────────────────────────────────────────────────────────────────────────────
# Gesture Engine
# ──────────────────────────────────────────────────────────────────────────────

class GestureEngine:
    """
    Real-time hand gesture recognition using the MediaPipe Tasks API.
    Falls back to OpenCV-only processing if model file is not found.
    """

    def __init__(self, model_path: str = None):
        self.landmarker = None
        self.static_model = None  # sklearn model
        self._init_landmarker()

        # Load optional sklearn classifier
        if model_path and os.path.exists(model_path):
            try:
                with open(model_path, 'rb') as f:
                    self.static_model = pickle.load(f)
                print(f"[Engine] Loaded sklearn model from {model_path}")
            except Exception as e:
                print(f"[Engine] Could not load sklearn model: {e}")

        # Motion buffer for dynamic gestures
        self.landmark_buffer = deque(maxlen=30)
        self.last_gesture = None
        self.gesture_hold_frames = 0
        self.HOLD_THRESHOLD = 12

        # Word building
        self.word_buffer = []
        self.last_letter_time = 0
        self.LETTER_PAUSE = 1.5

    @property
    def recognition_mode(self) -> str:
        """Return a UI-safe description of the active recognition pipeline."""
        if self.landmarker and self.static_model:
            return "mediapipe+sklearn"
        if self.landmarker:
            return "mediapipe-hand-landmarks"
        return "opencv-fallback"

    @property
    def is_model_ready(self) -> bool:
        """True when MediaPipe landmarks are available for recognition."""
        return self.landmarker is not None

    def _init_landmarker(self):
        """Initialize MediaPipe HandLandmarker from model file."""
        if mp is None:
            print("[Engine] MediaPipe is not installed")
            print("[Engine] Running in OpenCV-only mode (rule-based detection)")
            return

        model_path = HAND_LANDMARKER_MODEL
        if not os.path.exists(model_path):
            print(f"[Engine] Model not found at {model_path}")
            print("[Engine] Running in OpenCV-only mode (rule-based detection)")
            return

        try:
            base_options = mp_python.BaseOptions(model_asset_path=model_path)
            options = mp_vision.HandLandmarkerOptions(
                base_options=base_options,
                running_mode=mp_vision.RunningMode.IMAGE,
                num_hands=2,
                min_hand_detection_confidence=0.6,
                min_hand_presence_confidence=0.5,
                min_tracking_confidence=0.5,
            )
            self.landmarker = mp_vision.HandLandmarker.create_from_options(options)
            print("[Engine] HandLandmarker initialized successfully")
        except Exception as e:
            print(f"[Engine] HandLandmarker init failed: {e}")
            self.landmarker = None

    def extract_landmarks_array(self, hand_landmarks) -> np.ndarray:
        """Convert hand landmarks to flat numpy array (63 values: 21 pts × xyz)."""
        pts = []
        for lm in hand_landmarks:
            pts.extend([lm.x, lm.y, lm.z])
        return np.array(pts, dtype=np.float32)

    def draw_landmarks_on_frame(self, frame: np.ndarray, hand_landmarks_list) -> np.ndarray:
        """Draw hand skeleton on frame."""
        annotated = frame.copy()
        h, w = frame.shape[:2]

        for hand_lms in hand_landmarks_list:
            # Draw connections
            for start_idx, end_idx in HAND_CONNECTIONS:
                if start_idx < len(hand_lms) and end_idx < len(hand_lms):
                    x1 = int(hand_lms[start_idx].x * w)
                    y1 = int(hand_lms[start_idx].y * h)
                    x2 = int(hand_lms[end_idx].x * w)
                    y2 = int(hand_lms[end_idx].y * h)
                    cv2.line(annotated, (x1, y1), (x2, y2), (255, 100, 0), 2)

            # Draw keypoints
            for i, lm in enumerate(hand_lms):
                x = int(lm.x * w)
                y = int(lm.y * h)
                color = (0, 220, 255)
                size = 5 if i in [4, 8, 12, 16, 20] else 3  # fingertips bigger
                cv2.circle(annotated, (x, y), size, color, -1)

        return annotated

    def detect_dynamic_gesture(self, landmarks_seq: list) -> str | None:
        """Rule-based dynamic gesture detection from landmark sequence."""
        if len(landmarks_seq) < 8:
            return None

        seq = np.array(landmarks_seq)  # (N, 63)

        # Wrist x-motion for wave detection
        wrist_x = seq[:, 0]
        motion_range = float(wrist_x.max() - wrist_x.min())

        latest = seq[-1].reshape(21, 3)
        wrist = latest[0]
        thumb_tip = latest[4]
        index_tip = latest[8]
        middle_tip = latest[12]
        ring_tip = latest[16]
        pinky_tip = latest[20]
        palm_center = latest[9]  # middle MCP as palm reference

        def above_palm(tip, threshold=0.05):
            return tip[1] < palm_center[1] - threshold

        def below_palm(tip, threshold=0.05):
            return tip[1] > palm_center[1] + threshold

        # Wave: large horizontal wrist motion
        if motion_range > 0.22:
            return 'wave'

        # Open palm: all fingertips up
        if all(above_palm(t, 0.08) for t in [index_tip, middle_tip, ring_tip, pinky_tip]):
            return 'open_palm'

        # Fist: all fingertips near palm
        if all(abs(t[1] - palm_center[1]) < 0.10 for t in [index_tip, middle_tip, ring_tip, pinky_tip]):
            return 'fist'

        # Thumbs up: thumb above palm, others closed
        if (thumb_tip[1] < wrist[1] - 0.15 and
                not above_palm(index_tip, 0.08) and
                not above_palm(middle_tip, 0.08)):
            return 'thumbs_up'

        # Thumbs down: thumb below wrist, others closed
        if (thumb_tip[1] > palm_center[1] + 0.15 and
                not above_palm(index_tip, 0.08) and
                not above_palm(middle_tip, 0.08)):
            return 'thumbs_down'

        # Peace/V: index + middle up, ring + pinky closed
        if (above_palm(index_tip, 0.10) and
                above_palm(middle_tip, 0.10) and
                not above_palm(ring_tip, 0.05) and
                not above_palm(pinky_tip, 0.05)):
            return 'peace'

        # Point up: only index extended
        if (above_palm(index_tip, 0.12) and
                not above_palm(middle_tip, 0.08) and
                not above_palm(ring_tip, 0.05)):
            return 'point_up'

        # OK sign: thumb and index close, others extended
        dist_ok = np.linalg.norm(index_tip - thumb_tip)
        if (dist_ok < 0.05 and
                above_palm(middle_tip, 0.08) and
                above_palm(ring_tip, 0.05) and
                above_palm(pinky_tip, 0.05)):
            return 'ok_sign'

        # Pinched (Chef's kiss): all tips close to thumb tip
        dist_idx = np.linalg.norm(index_tip - thumb_tip)
        dist_mid = np.linalg.norm(middle_tip - thumb_tip)
        dist_ring = np.linalg.norm(ring_tip - thumb_tip)
        dist_pinky = np.linalg.norm(pinky_tip - thumb_tip)
        if max(dist_idx, dist_mid, dist_ring, dist_pinky) < 0.08:
            return 'pinched'

        # Call me: thumb and pinky extended sideways/up, others closed
        if (above_palm(pinky_tip, 0.05) and
                thumb_tip[1] < palm_center[1] and
                not above_palm(index_tip, 0.05) and
                not above_palm(middle_tip, 0.05) and
                not above_palm(ring_tip, 0.05)):
            # extra check for thumb distance
            if np.linalg.norm(thumb_tip - pinky_tip) > 0.15:
                return 'call_me'

        return None

    def classify_static(self, lm: np.ndarray) -> tuple[str, float]:
        """Classify static hand gesture (ASL letter)."""
        if self.static_model is not None:
            try:
                pred = self.static_model.predict([lm])[0]
                proba = self.static_model.predict_proba([lm])[0]
                return str(pred), float(proba.max())
            except Exception:
                pass

        # Fallback: simple rule-based
        return self._rule_based_static(lm)

    def _rule_based_static(self, lm: np.ndarray) -> tuple[str, float]:
        """Simple rule-based static classifier for demo."""
        pts = lm.reshape(21, 3)

        def is_ext(tip, mcp):
            return pts[tip][1] < pts[mcp][1] - 0.04

        thumb_open = pts[4][0] > pts[3][0] + 0.02
        idx   = is_ext(8, 5)
        mid   = is_ext(12, 9)
        ring  = is_ext(16, 13)
        pinky = is_ext(20, 17)

        if thumb_open and idx and not mid and not ring and not pinky:
            return 'L', 0.78
        if thumb_open and idx and mid and not ring and not pinky:
            return 'K', 0.65
        if not thumb_open and idx and mid and not ring and not pinky:
            dist = np.linalg.norm(pts[8] - pts[12])
            if dist < 0.05:
                return 'U', 0.70
            return 'V', 0.78
        if not thumb_open and idx and mid and ring and pinky:
            return 'B', 0.72
        if not idx and not mid and not ring and not pinky:
            return 'A', 0.68
        if idx and mid and ring and not pinky:
            return 'W', 0.72
        if thumb_open and not idx and not mid and not ring and pinky:
            return 'Y', 0.72
        if not thumb_open and idx and not mid and not ring and pinky:
            return 'I', 0.70
        if thumb_open and idx and not mid and not ring and pinky:
            return 'I-LOVE-YOU', 0.70
        if not thumb_open and idx and not mid and not ring and not pinky:
            return 'D', 0.75
        if not idx and mid and ring and pinky:
            return 'F', 0.75
        if thumb_open and not idx and not mid and not ring and not pinky:
            return 'A', 0.50 # fallback for closed fist with thumb out


        return 'UNKNOWN', 0.30

    def process_frame(self, frame: np.ndarray, include_annotated_frame: bool = False) -> dict:
        """
        Process a single BGR frame.
        Returns dict with: gesture, confidence, type, translation, word,
                           annotated_frame, landmarks_detected
        """
        result = {
            'gesture': None,
            'confidence': 0.0,
            'type': 'none',
            'translation': '',
            'word': ''.join(self.word_buffer),
            'annotated_frame': frame.copy() if include_annotated_frame else None,
            'landmarks_detected': False,
            'hand_landmarks': [],
        }

        # Use HandLandmarker if available
        if self.landmarker is not None:
            try:
                rgb_frame = cv2.cvtColor(frame, cv2.COLOR_BGR2RGB)
                mp_image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb_frame)
                detection_result = self.landmarker.detect(mp_image)

                if detection_result.hand_landmarks:
                    result['landmarks_detected'] = True
                    hand_lms = detection_result.hand_landmarks[0]  # primary hand
                    result['hand_landmarks'] = [
                        [[round(point.x, 4), round(point.y, 4)] for point in hand]
                        for hand in detection_result.hand_landmarks
                    ]

                    if include_annotated_frame:
                        result['annotated_frame'] = self.draw_landmarks_on_frame(
                            frame, detection_result.hand_landmarks
                        )

                    # Extract numpy array
                    lm_array = self.extract_landmarks_array(hand_lms)
                    self.landmark_buffer.append(lm_array)

                    # Try dynamic first
                    dyn = self.detect_dynamic_gesture(list(self.landmark_buffer))
                    if dyn:
                        result.update({
                            'gesture': dyn,
                            'confidence': 0.87,
                            'type': 'dynamic',
                            'translation': DYNAMIC_GESTURES.get(dyn, dyn)
                        })
                    else:
                        # Static classification
                        letter, conf = self.classify_static(lm_array)
                        if conf > 0.55 and letter not in ('UNKNOWN',):
                            result.update({
                                'gesture': letter,
                                'confidence': conf,
                                'type': 'static',
                                'translation': letter
                            })
                            self._update_word_buffer(letter, conf)
                else:
                    self.landmark_buffer.clear()

            except Exception as e:
                print(f"[Engine] Detection error: {e}")
        else:
            # OpenCV-only mode: detect skin regions (fallback)
            result = self._opencv_fallback(frame, result, include_annotated_frame)

        result['word'] = ''.join(self.word_buffer)
        return result

    def _opencv_fallback(
            self,
            frame: np.ndarray,
            result: dict,
            include_annotated_frame: bool = False,
    ) -> dict:
        """OpenCV skin detection fallback when MediaPipe model is unavailable."""
        hsv = cv2.cvtColor(frame, cv2.COLOR_BGR2HSV)
        # Skin color range in HSV
        lower = np.array([0, 20, 70])
        upper = np.array([20, 255, 255])
        mask = cv2.inRange(hsv, lower, upper)

        # Morphological cleanup
        kernel = np.ones((5, 5), np.uint8)
        mask = cv2.dilate(mask, kernel, iterations=2)
        mask = cv2.erode(mask, kernel, iterations=1)

        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        annotated = frame.copy() if include_annotated_frame else None
        if contours:
            largest = max(contours, key=cv2.contourArea)
            area = cv2.contourArea(largest)

            if area > 5000:  # Hand detected
                result['landmarks_detected'] = True
                hull = cv2.convexHull(largest)
                if annotated is not None:
                    cv2.drawContours(annotated, [hull], -1, (0, 220, 255), 2)
                    cv2.drawContours(annotated, [largest], -1, (255, 100, 0), 2)

                # Count fingers via convexity defects
                fingers = self._count_fingers(largest)
                gesture_map = {
                    0: ('fist', 'No / Нет'),
                    1: ('point_up', 'Yes / Да'),
                    2: ('peace', 'Peace / Мир'),
                    3: ('THREE', 'Три'),
                    4: ('FOUR', 'Четыре'),
                    5: ('open_palm', 'Stop / Стоп'),
                }
                gesture, translation = gesture_map.get(fingers, ('UNKNOWN', ''))
                if gesture != 'UNKNOWN':
                    result.update({
                        'gesture': gesture,
                        'confidence': 0.65,
                        'type': 'dynamic',
                        'translation': translation
                    })

        result['annotated_frame'] = annotated
        return result

    def _count_fingers(self, contour) -> int:
        """Count extended fingers using convexity defects."""
        try:
            hull = cv2.convexHull(contour, returnPoints=False)
            if hull is None or len(hull) < 3:
                return 0
            defects = cv2.convexityDefects(contour, hull)
            if defects is None:
                return 0

            count = 0
            for i in range(defects.shape[0]):
                s, e, f, d = defects[i, 0]
                far = tuple(contour[f][0])
                start = tuple(contour[s][0])
                end = tuple(contour[e][0])

                a = np.linalg.norm(np.array(end) - np.array(start))
                b = np.linalg.norm(np.array(far) - np.array(start))
                c = np.linalg.norm(np.array(end) - np.array(far))

                if b > 0 and c > 0:
                    angle = np.arccos((b**2 + c**2 - a**2) / (2 * b * c))
                    if angle < np.pi / 2 and d > 10000:
                        count += 1

            return min(count + 1, 5)
        except Exception:
            return 0

    def _update_word_buffer(self, letter: str, conf: float):
        """Accumulate letters into words based on hold duration."""
        now = time.time()
        if letter == self.last_gesture:
            self.gesture_hold_frames += 1
            if (self.gesture_hold_frames == self.HOLD_THRESHOLD and
                    now - self.last_letter_time > self.LETTER_PAUSE):
                if letter == 'SPACE':
                    self.word_buffer.append(' ')
                elif letter == 'DELETE' and self.word_buffer:
                    self.word_buffer.pop()
                elif letter not in ('NOTHING', 'UNKNOWN'):
                    self.word_buffer.append(letter)
                self.last_letter_time = now
        else:
            self.gesture_hold_frames = 0
        self.last_gesture = letter

    def clear_word(self):
        """Clear accumulated word buffer."""
        self.word_buffer.clear()
        self.last_gesture = None
        self.gesture_hold_frames = 0

    def release(self):
        """Release resources."""
        if self.landmarker:
            try:
                self.landmarker.close()
            except Exception:
                pass


# ──────────────────────────────────────────────────────────────────────────────
# Quick test
# ──────────────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    print("Testing GestureEngine...")
    engine = GestureEngine()
    cap = cv2.VideoCapture(0)

    if not cap.isOpened():
        print("No camera found!")
    else:
        print("Press Q to quit")
        while True:
            ret, frame = cap.read()
            if not ret:
                break
            frame = cv2.flip(frame, 1)
            res = engine.process_frame(frame)

            cv2.putText(res['annotated_frame'],
                        f"Gesture: {res['gesture']} ({res['confidence']:.0%})",
                        (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, (0, 255, 0), 2)
            cv2.putText(res['annotated_frame'],
                        f"Translation: {res['translation']}",
                        (10, 65), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (255, 200, 0), 2)
            cv2.putText(res['annotated_frame'],
                        f"Word: {res['word']}",
                        (10, 100), cv2.FONT_HERSHEY_SIMPLEX, 0.7, (200, 255, 0), 2)

            cv2.imshow('SignBridge Test', res['annotated_frame'])
            if cv2.waitKey(1) & 0xFF == ord('q'):
                break

    cap.release()
    cv2.destroyAllWindows()
    engine.release()

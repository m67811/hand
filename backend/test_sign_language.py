"""Regression tests for the data-driven avatar planner."""

import unittest

from sign_language import translator


class SignLanguagePlannerTests(unittest.TestCase):
    def test_english_phrase_is_greedily_matched(self):
        plan = translator.plan("Where is the bathroom", "en")
        self.assertEqual(plan["glosses"], ["WHERE", "BATHROOM"])
        self.assertEqual(plan["coverage"], 100)

    def test_russian_phrase_is_greedily_matched(self):
        plan = translator.plan("Мне нужна помощь", "ru")
        self.assertEqual(plan["glosses"], ["ME", "NEED", "HELP"])
        self.assertFalse(plan["unknown_words"])

    def test_unknown_word_is_fingerspelled_and_reported(self):
        plan = translator.plan("hello quantum", "en")
        self.assertEqual(plan["unknown_words"], ["quantum"])
        self.assertIn("Q", plan["glosses"])
        self.assertEqual(plan["coverage"], 50)

    def test_sequence_has_pause_between_units(self):
        plan = translator.plan("hello water", "en")
        self.assertEqual([item["gesture"] for item in plan["sequence"]], ["wave", "PAUSE", "water", "PAUSE"])

    def test_english_function_words_are_not_fingerspelled(self):
        plan = translator.plan("I am happy", "en")
        self.assertEqual(plan["dropped_words"], ["am"])
        self.assertEqual(plan["glosses"], ["ME", "HAPPY"])


if __name__ == "__main__":
    unittest.main()

import unittest

import session_start_hook


class SessionStartHookTests(unittest.TestCase):
    def test_output_is_concise_and_points_to_task_recall(self):
        text = session_start_hook.build_project_memory_text("Summary. " * 200)
        self.assertLessEqual(session_start_hook.estimate_tokens(text), 300)
        self.assertIn("recall_task_context", text)
        self.assertIn("search_memory", text)
        self.assertNotIn("## Key artifacts", text)


if __name__ == "__main__":
    unittest.main()

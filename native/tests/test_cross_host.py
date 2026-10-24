"""Command construction regressions; no host binaries or network required."""
import pathlib
import tempfile
import types
import unittest
from unittest.mock import patch

from cross_host import Harness, REPO


class EntryPathTests(unittest.TestCase):
    def command(self, entry=None, mode="pig-typescript"):
        # Only exercise the shared command builder, not the HTTP server lifecycle.
        harness = object.__new__(Harness)
        harness.args = types.SimpleNamespace(
            node="node", pi=pathlib.Path("/pi/cli.js"),
            pig=pathlib.Path("/pig"), fused=pathlib.Path("/fused"),
            pig_typescript_entry=entry,
        )
        return harness.command(mode, "nested", pathlib.Path("/verification/run"))

    def test_relative_entry_uses_invoking_directory_not_repository_or_workspace(self):
        with tempfile.TemporaryDirectory() as directory:
            caller = pathlib.Path(directory).resolve()
            entry = pathlib.Path("custom/pig-index.ts")
            with patch("os.getcwd", return_value=str(caller)):
                command = self.command(entry)
            expected = caller / entry
            self.assertIn(str(expected), command)
            self.assertNotIn(str(entry), command)
            self.assertNotIn(str(REPO / entry), command)

    def test_absolute_entry_is_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            entry = pathlib.Path(directory).resolve() / "pig-index.ts"
            self.assertIn(str(entry), self.command(entry))

    def test_default_entry_stays_unchanged(self):
        self.assertIn(str(REPO / "src/index.ts"), self.command())

    def test_pig_override_does_not_change_pi_entry(self):
        command = self.command(pathlib.Path("custom/pig-index.ts"), mode="pi-typescript")
        self.assertIn(str(REPO / "src/index.ts"), command)
        self.assertNotIn("custom/pig-index.ts", command)


if __name__ == "__main__":
    unittest.main()

import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]


class DeploySecurityRegressionTests(unittest.TestCase):
    def read_text(self, relative_path: str) -> str:
        return (REPO_ROOT / relative_path).read_text(encoding="utf-8")

    def test_deploy_direct_ps1_does_not_persist_passwords(self) -> None:
        script = self.read_text("deploy_direct.ps1")

        self.assertNotIn("Initialize-SshAskPass", script)
        self.assertNotIn("ConvertTo-PlainText", script)
        self.assertNotIn("SSH_ASKPASS", script)
        self.assertNotIn("PasswordAuthentication=yes", script)
        self.assertNotIn("StrictHostKeyChecking=accept-new", script)
        self.assertIn("StrictHostKeyChecking=yes", script)

    def test_deploy_live_scripts_reject_unknown_host_keys(self) -> None:
        for relative_path in (
            "tools/deploy_live.py",
            ".deploy-backups/20260408_222716/tools/deploy_live.py",
        ):
            with self.subTest(path=relative_path):
                script = self.read_text(relative_path)
                self.assertNotIn("AutoAddPolicy", script)
                self.assertIn("RejectPolicy", script)
                self.assertIn("load_system_host_keys", script)


if __name__ == "__main__":
    unittest.main()

from __future__ import annotations

from dev_firm import db
from dev_firm.orchestrator.build import BuildService


def test_mock_build_creates_artifacts(settings):
    result = BuildService(settings).run("A tiny local app", title="Demo")
    assert result["mock"] is True
    with db.session(settings.db_path) as conn:
        workflow = db.get_workflow(conn, result["workflow_id"])
        artifacts = db.list_artifacts(conn, result["workflow_id"])
    assert workflow["status"] == "done"
    names = {artifact["name"] for artifact in artifacts}
    assert {"product_spec.md", "architecture.md", "qa_report.md"} <= names
    assert all(artifact["content"] for artifact in artifacts)

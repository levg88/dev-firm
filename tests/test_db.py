from __future__ import annotations

from dev_firm import db


def test_workflow_agent_run_and_artifact_round_trip(settings):
    with db.session(settings.db_path) as conn:
        wf_id = db.create_workflow(conn, "build", "test", {"brief": "x"})
        run_id = db.start_agent_run(
            conn, wf_id, "build", "developer", {"task": "x"}, "mock", "mock"
        )
        db.finish_agent_run(conn, run_id, "ok", {"summary": "done"}, prompt_tokens=1, completion_tokens=2)
        db.save_artifact(conn, wf_id, run_id, "a.md", "markdown", "hello")

    with db.session(settings.db_path) as conn:
        workflow = db.get_workflow(conn, wf_id)
        runs = db.list_agent_runs(conn, workflow_run_id=wf_id)
        artifacts = db.list_artifacts(conn, wf_id)
        stats = db.stats(conn)

    assert workflow["title"] == "test"
    assert workflow["input"] == {"brief": "x"}
    assert runs[0]["role"] == "developer"
    assert runs[0]["status"] == "ok"
    assert runs[0]["prompt_tokens"] == 1
    assert artifacts[0]["content"] == "hello"
    assert stats["workflow_runs"] == 1
    assert stats["agent_runs"] == 1


def test_app_settings_round_trip(settings):
    with db.session(settings.db_path) as conn:
        db.save_app_settings(conn, {"provider": "ollama", "model": "llama3.1"})
        assert db.get_app_settings(conn)["provider"] == "ollama"
        db.save_app_settings(conn, {"provider": "mock"})
        assert db.get_app_settings(conn)["model"] == "llama3.1"
        db.clear_app_settings(conn)
        assert db.get_app_settings(conn) == {}

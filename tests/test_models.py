from __future__ import annotations

from dev_firm.models import QAReport


def test_qa_report_accepts_loose_list_shapes():
    report = QAReport.model_validate(
        {
            "passed": True,
            "summary": "Looks good",
            "issues": "minor naming",
            "tests_run": {"pytest": ["test_app.py"]},
        }
    )
    assert report.passed is True
    assert report.issues == ["minor naming"]
    assert report.tests_run == ["pytest: test_app.py"]

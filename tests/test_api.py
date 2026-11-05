from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from dev_firm.api.app import create_app


@pytest.fixture
def client(settings):
    return TestClient(create_app(settings))


def test_pages_render(client):
    for path in ("/", "/build", "/runs", "/settings"):
        response = client.get(path)
        assert response.status_code == 200, path
    health = client.get("/health").json()
    assert health["ok"] is True
    assert health["provider"] == "mock"


def test_mock_build_via_api(client):
    response = client.post(
        "/build",
        data={"brief": "A local CLI that tracks reading list items", "title": "Reading list"},
        follow_redirects=False,
    )
    assert response.status_code == 303
    location = response.headers["location"]
    detail = client.get(location)
    assert detail.status_code == 200
    assert "product_spec.md" in detail.text
    assert "qa_report.md" in detail.text
    assert client.get(location + "/status").json()["status"] == "done"


def test_empty_brief_is_rejected(client):
    response = client.post("/build", data={"brief": "  "})
    assert response.status_code == 400
    assert "Describe the app you want to build" in response.text

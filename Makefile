.PHONY: install test serve init doctor

install:
	python3 -m venv .venv
	.venv/bin/pip install -e ".[dev]"

test:
	.venv/bin/pytest -q

init:
	.venv/bin/dev-firm init

doctor:
	.venv/bin/dev-firm doctor

serve:
	.venv/bin/dev-firm serve

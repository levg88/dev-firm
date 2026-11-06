.PHONY: install build start dev test typecheck check clean jira-status jira-init

install:
	npm install

build:
	npm run build

start:
	npm start

dev:
	npm run dev

test:
	npm test

typecheck:
	npm run typecheck

check: typecheck test

clean:
	rm -rf dist coverage

jira-status:
	npm run cli -- jira status

jira-init:
	npm run cli -- jira init --project-key $${JIRA_PROJECT_KEY:-CAREER} --project-name "$${JIRA_PROJECT_NAME:-Career Team}"

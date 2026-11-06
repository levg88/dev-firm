.PHONY: install build start dev test typecheck check clean github-status github-init github-sync

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

github-status:
	npm run cli -- github status

github-init:
	npm run cli -- github init --owner $${GITHUB_OWNER:-levg88} --repo $${GITHUB_REPO:-career-firm} --title "$${GITHUB_PROJECT_TITLE:-Career Team}"

github-sync:
	npm run cli -- github sync

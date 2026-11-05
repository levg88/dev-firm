.PHONY: install build start dev test typecheck clean

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

clean:
	rm -rf dist coverage

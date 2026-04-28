.PHONY: help install check test-all test test-orchestrator test-e2e build build-orchestrator build-e2e lint format worker workflow e2e-live-fake e2e-live-real

help: ## Show available targets
	@awk 'BEGIN {FS = ":.*## "; print "Available targets:"} /^[a-zA-Z0-9_-]+:.*## / {printf "  %-18s %s\n", $$1, $$2}' $(MAKEFILE_LIST)

install: ## Install workspace dependencies
	npm install

check: lint test build ## Run the common verification suite

test-all: test ## Alias for all tests

test: test-orchestrator test-e2e ## Run all tests

test-orchestrator: ## Run orchestrator tests
	npm --workspace orchestrator test

test-e2e: build-orchestrator ## Run e2e tests
	npm --workspace e2e test

build: ## Build orchestrator and e2e
	npm --workspace orchestrator run build
	npm --workspace e2e run build

build-orchestrator: ## Build orchestrator package
	npm --workspace orchestrator run build

build-e2e: ## Build e2e package
	npm --workspace e2e run build

lint: ## Run orchestrator lint
	npm --workspace orchestrator run lint

format: ## Run orchestrator format
	npm --workspace orchestrator run format

worker: ## Start the orchestrator worker
	npm --workspace orchestrator start

workflow: ## Run the orchestrator workflow client (pass args with ARGS="...")
	npm --workspace orchestrator run workflow -- $(ARGS)

e2e-live-fake: ## Run the live e2e suite in fake-agent mode
	npm --workspace e2e run live:fake

e2e-live-real: ## Run the live e2e suite in real-agent mode
	npm --workspace e2e run live:real
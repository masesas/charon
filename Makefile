# Charon — Docker Compose operations
#
# Dev vs Prod (matches docker-compose.yml comments):
#   - Dev (local):  `docker compose ...`         → auto-merges docker-compose.override.yml
#                                                   (live-reload dashboard via bind-mounted src/)
#   - Prod (VPS):   `docker compose -f docker-compose.yml ...`  → override.yml is NOT merged
#
# Targets ending in `-prod` use the prod invocation. Plain targets use the dev invocation.
# The trading engine (`charon`) is LIVE — `rebuild`/`deploy` recreate it; use with intent.

# ── Configuration ────────────────────────────────────────────────────────────
COMPOSE       ?= docker compose
COMPOSE_FILE  ?= docker-compose.yml
COMPOSE_PROD  ?= $(COMPOSE) -f $(COMPOSE_FILE)
ENGINE        ?= charon
DASHBOARD     ?= charon-dashboard
# Container names (container_name: in compose) — used by `docker inspect`, which
# resolves names, not compose service names. Engine service `charon` → `charon-engine`.
ENGINE_CTR    ?= charon-engine
DASHBOARD_CTR ?= charon-dashboard
# Service to act on for single-service targets (override: `make restart-one SERVICE=charon-dashboard`)
SERVICE       ?= $(ENGINE)
# Tail length for log targets (override: `make logs N=500`)
N             ?= 200

# All recipes are phony (no files produced).
.PHONY: help \
  build build-prod rebuild rebuild-prod deploy \
  up up-prod up-fg down down-volumes stop start \
  restart restart-prod restart-engine restart-dashboard restart-one \
  ps status health config validate \
  logs logs-engine logs-dashboard logs-one \
  shell shell-dashboard exec \
  pull prune clean

# Default target: show help.
.DEFAULT_GOAL := help

# ── Help ─────────────────────────────────────────────────────────────────────
help: ## Show this help
	@echo "Charon Docker operations"
	@echo ""
	@echo "Usage: make <target> [SERVICE=charon-dashboard] [N=500]"
	@echo ""
	@grep -E '^[a-zA-Z0-9_-]+:.*## ' $(MAKEFILE_LIST) \
	  | sort \
	  | awk 'BEGIN{FS=":.*## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── Build / rebuild / deploy ─────────────────────────────────────────────────
build: ## Build images (dev) without starting
	$(COMPOSE) build

build-prod: ## Build images (prod, no override)
	$(COMPOSE_PROD) build

rebuild: ## Rebuild images from scratch (no cache) and recreate containers (dev)
	$(COMPOSE) build --no-cache
	$(COMPOSE) up -d --force-recreate

rebuild-prod: ## Rebuild from scratch and recreate (prod, no override)
	$(COMPOSE_PROD) build --no-cache
	$(COMPOSE_PROD) up -d --force-recreate

deploy: ## Prod deploy: build changed layers + recreate in background (no override)
	$(COMPOSE_PROD) up -d --build

# ── Lifecycle: up / down / start / stop ──────────────────────────────────────
up: ## Start all services in background (dev)
	$(COMPOSE) up -d

up-prod: ## Start all services in background (prod, no override)
	$(COMPOSE_PROD) up -d

up-fg: ## Start in foreground with logs attached (Ctrl-C to stop)
	$(COMPOSE) up

down: ## Stop and remove containers + networks (keeps volumes/DB)
	$(COMPOSE) down

down-volumes: ## Stop and remove containers + networks + named volumes (DANGER: drops charon-logs)
	$(COMPOSE) down --volumes

stop: ## Stop containers without removing them
	$(COMPOSE) stop

start: ## Start previously-stopped containers
	$(COMPOSE) start

# ── Restart ──────────────────────────────────────────────────────────────────
restart: ## Restart all services (dev)
	$(COMPOSE) restart

restart-prod: ## Restart all services (prod, no override)
	$(COMPOSE_PROD) restart

restart-engine: ## Restart only the trading engine (charon)
	$(COMPOSE) restart $(ENGINE)

restart-dashboard: ## Restart only the dashboard
	$(COMPOSE) restart $(DASHBOARD)

restart-one: ## Restart a single service (SERVICE=...)
	$(COMPOSE) restart $(SERVICE)

# ── Status / inspection ──────────────────────────────────────────────────────
ps status: ## Show container status
	$(COMPOSE) ps

health: ## Show health/status of each container
	@docker inspect --format '{{.Name}}: {{.State.Status}} (health: {{if .State.Health}}{{.State.Health.Status}}{{else}}n/a{{end}})' \
	  $(ENGINE_CTR) $(DASHBOARD_CTR) 2>/dev/null || echo "containers not running"

config: ## Render the merged compose config (dev)
	$(COMPOSE) config

validate: ## Validate compose files (prod invocation) without starting anything
	$(COMPOSE_PROD) config -q && echo "compose config OK"

# ── Logs ─────────────────────────────────────────────────────────────────────
logs: ## Tail logs for all services (N=lines, default 200)
	$(COMPOSE) logs -f --tail=$(N)

logs-engine: ## Tail engine logs (N=lines)
	$(COMPOSE) logs -f --tail=$(N) $(ENGINE)

logs-dashboard: ## Tail dashboard logs (N=lines)
	$(COMPOSE) logs -f --tail=$(N) $(DASHBOARD)

logs-one: ## Tail logs for a single service (SERVICE=..., N=lines)
	$(COMPOSE) logs -f --tail=$(N) $(SERVICE)

# ── Exec / shell ─────────────────────────────────────────────────────────────
shell: ## Open a shell in the engine container
	$(COMPOSE) exec $(ENGINE) sh

shell-dashboard: ## Open a shell in the dashboard container
	$(COMPOSE) exec $(DASHBOARD) sh

exec: ## Run a command in a service (SERVICE=... CMD="node -v")
	$(COMPOSE) exec $(SERVICE) $(CMD)

# ── Maintenance ──────────────────────────────────────────────────────────────
pull: ## Pull latest base images
	$(COMPOSE) pull

prune: ## Remove dangling images and build cache (safe; keeps named volumes)
	docker image prune -f
	docker builder prune -f

clean: ## Down + remove dangling images (keeps DB volume/bind mount)
	$(COMPOSE) down --remove-orphans
	docker image prune -f

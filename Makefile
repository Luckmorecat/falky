IN_SERVER := cd server &&
IN_WEB := cd web &&

# The contract and the Go code generated from it (paths relative to server/).
API_SPEC := ../api/openapi.yaml
API_GEN := internal/api/api.gen.go
OAPI_CODEGEN := go tool oapi-codegen -config internal/api/oapi-codegen.yaml
# The client's types, generated from the same contract (relative to web/).
WEB_API_GEN := src/api/schema.gen.ts
WEB_API_FRESH := node_modules/.cache/schema.gen.ts
SCHEMA_OUT ?= artifacts/schema

.PHONY: check check-server check-web check-deploy fmt lint lint-api check-generated test test-integration smoke generate generate-web schema

# The complete application check gate. CI runs the two components in parallel.
check:
	@$(MAKE) --no-print-directory check-server
	@$(MAKE) --no-print-directory check-web

# The backend and shared API contract.
check-server:
	@$(MAKE) --no-print-directory lint-api
	@$(MAKE) --no-print-directory check-generated
	$(IN_SERVER) golangci-lint fmt --diff
	$(IN_SERVER) go build ./...
	$(IN_SERVER) go vet ./...
	@$(MAKE) --no-print-directory lint
	@$(MAKE) --no-print-directory test
	$(IN_SERVER) go tool govulncheck ./...

# Deployment safety and workflow validation, independent of application checks.
check-deploy:
	npm --prefix release ci --ignore-scripts
	npm --prefix release test
	bash -n deploy/manage.sh deploy/compose.sh deploy/ci-deploy.sh deploy/ci-ssh.sh
	python3 deploy/ci-check_test.py
	python3 deploy/ci-plan_test.py
	python3 deploy/manage_test.py
	python3 deploy/release_test.py
	python3 deploy/config_test.py
	actionlint

# The web client: its types match the contract, it type-checks, its tests pass
# and it builds.
check-web:
	$(IN_WEB) pnpm install --frozen-lockfile
	$(IN_WEB) pnpm exec openapi-typescript $(API_SPEC) -o $(WEB_API_FRESH) --silent && \
		diff -u $(WEB_API_GEN) $(WEB_API_FRESH) || \
		{ echo "web/$(WEB_API_GEN) is stale: run make generate-web" >&2; exit 1; }
	$(IN_WEB) pnpm test
	$(IN_WEB) pnpm run build

fmt:
	$(IN_SERVER) golangci-lint fmt

lint:
	$(IN_SERVER) golangci-lint run

# Lints the contract; warnings fail too.
lint-api:
	$(IN_SERVER) go tool vacuum lint --no-update-check --no-banner --details --fail-severity warn $(API_SPEC)

# Regenerates into a temporary file and fails if the committed code differs.
check-generated:
	$(IN_SERVER) tmp=$$(mktemp -d) && trap 'rm -rf "$$tmp"' EXIT && \
		$(OAPI_CODEGEN) -o "$$tmp/api.gen.go" $(API_SPEC) && \
		diff -u $(API_GEN) "$$tmp/api.gen.go" || \
		{ echo "$(API_GEN) is stale: run make generate" >&2; exit 1; }

test:
	$(IN_SERVER) go test -race ./...

test-integration:
	$(IN_SERVER) go test -race -tags integration ./...

# Checks the running Compose stack (deploy/compose.yaml) end to end through
# Caddy. It replaces the access password: run it only on a stack nobody uses.
smoke:
	$(IN_SERVER) go run ./cmd/smoke -compose ../deploy/compose.yaml

generate:
	$(IN_SERVER) $(OAPI_CODEGEN) -o $(API_GEN) $(API_SPEC)

generate-web:
	$(IN_WEB) pnpm run generate

schema:
	python3 server/scripts/schema.py --output "$(SCHEMA_OUT)"

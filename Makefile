IN_SERVER := cd server &&

# The contract and the Go code generated from it (paths relative to server/).
API_SPEC := ../api/openapi.yaml
API_GEN := internal/api/api.gen.go
OAPI_CODEGEN := go tool oapi-codegen -config internal/api/oapi-codegen.yaml

.PHONY: check fmt lint lint-api check-generated test test-integration smoke generate

# The done condition: every step must pass, in this order.
check:
	@$(MAKE) --no-print-directory lint-api
	@$(MAKE) --no-print-directory check-generated
	$(IN_SERVER) golangci-lint fmt --diff
	$(IN_SERVER) go build ./...
	$(IN_SERVER) go vet ./...
	@$(MAKE) --no-print-directory lint
	@$(MAKE) --no-print-directory test
	$(IN_SERVER) go tool govulncheck ./...

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
# Caddy. It replaces the access link: run it only on a stack nobody uses.
smoke:
	$(IN_SERVER) go run ./cmd/smoke -compose ../deploy/compose.yaml

generate:
	$(IN_SERVER) $(OAPI_CODEGEN) -o $(API_GEN) $(API_SPEC)

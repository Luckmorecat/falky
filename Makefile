IN_SERVER := cd server &&

.PHONY: check fmt lint test test-integration generate

# The done condition: every step must pass, in this order.
check:
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

test:
	$(IN_SERVER) go test -race ./...

test-integration:
	$(IN_SERVER) go test -race -tags integration ./...

generate:
	$(IN_SERVER) go generate ./...

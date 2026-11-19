.PHONY: setup check static mutation faults crash

setup:
	npm ci && npm run pack:framework && npm run install:packed

## The gate: every ticket passes this before its PR (as agbossjs/agboss's `make check`)
check:
	npm run check

## The cheap stages, run before queueing for a gate slot
static:
	npm run check:static

## One mutation shard: make mutation SHARD=leases
mutation:
	MUTATION_SHARD=$(SHARD) npm run test:mutation

faults:
	npm run test:faults

crash:
	npm run test:crash

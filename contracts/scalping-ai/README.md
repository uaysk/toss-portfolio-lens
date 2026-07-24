# Scalping AI contract fixtures

`valid/*.json` files are complete request payloads accepted by both the TypeScript
Zod contract and the Python Pydantic contract.

Each `invalid/*.json` file names a valid base payload and applies one deterministic
mutation. Both test suites implement the same three mutation operations (`set`,
`remove_last`, and `duplicate_item`) and require every resulting payload to be
rejected. Keeping the invalid cases as small mutations makes the causal difference
under test explicit while ensuring both runtimes read the same JSON fixture.

These fixtures validate the request contract only. They do not initialize an AI
model or download model weights.

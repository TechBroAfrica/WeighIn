# Strict Fixture Declaration Validation

## Overview

As of this change, WeighIn rejects fixture JSON files that contain unknown keys at any of the four
declaration levels. Previously, Zod's default `.strip()` behaviour would silently discard unknown
fields before identity assignment; now, any unrecognised key produces an error that names the
fixture file and the JSON path to the offending field. Parsing halts before any contract build,
account funding, deployment, or simulation step.

The primary motivation is preventing silent identity fallback: a misspelled optional `id` field
(e.g. `"idenitifer"` instead of `"id"`) was previously ignored, causing the fixture to use
path-based or argument-based identity without any warning. The new behaviour makes the error
explicit and immediate.

---

## Strict Declaration Levels

Four objects in a fixture file are validated strictly. Any key not listed in the **Allowed fields**
column causes a parse error.

| Level | Schema | Allowed fields |
|---|---|---|
| Fixture root | `FixturesSpecSchema` | `id` (optional), `contracts` (required) |
| Contract | `ContractSpecSchema` | `id` (optional), `wasm_path` (required), `invocations` (required) |
| Invocation | `InvocationSpecSchema` | `id` (optional), `function_name` (required), `args` (required) |
| Typed argument | `InvocationArgSchema` | `type` (required), `value` (required) |

All four schemas are defined in `src/config.ts` and use Zod's `.strict()` mode.

---

## Behaviour Change

**Before this change** — Zod used its default `.strip()` mode at parse time inside `parseFixtures`
in `src/identity.ts`. An object like:

```json
{
  "idenitifer": "my-suite",
  "contracts": [...]
}
```

would be silently accepted as a fixture with no explicit `id`, falling back to `path:` identity.
The misspelling went undetected and the intended `id:` identity was never used.

**After this change** — the same object produces an error immediately:

```
Invalid WeighIn configuration in weighin-fixtures.json:
- idenitifer: Unrecognized key(s) in object: 'idenitifer'
```

Parsing stops. No identity is assigned. No build, deployment, or simulation is attempted.

---

## Error Format

Every rejection error includes:

1. The fixture file path (the value passed as `fixturePath` to `parseFixtures`, typically the
   workspace-relative path such as `weighin-fixtures.json` or `nested/fixtures.json`).
2. The dot-notation JSON path to the offending key.
3. Zod's `Unrecognized key(s) in object` message listing the unknown key(s).

Example — unknown key on an invocation:

```
Invalid WeighIn configuration in weighin-fixtures.json:
- contracts.0.invocations.0.functoin_name: Unrecognized key(s) in object: 'functoin_name'
```

---

## What Is Validated in Typed Argument Values

The `value` field of a typed argument is typed as `z.any()` at the schema level, but
`InvocationArgSchema.superRefine` runs additional checks before side effects for the following
types:

- **`u64` / `i64` / `u128` / `i128`** — value must be a valid integer string within the type's
  range.
- **`address`** — value must be a string, and must parse as a valid Stellar address (account or
  contract). Invalid address strings are rejected with a `Invalid value for address:` message
  that includes the full dot-notation JSON path.
- **`bytes`** — value must be a string, must consist only of hexadecimal characters, and must have
  even length. Invalid hex strings are rejected with a `Invalid value for bytes:` message that
  includes the full dot-notation JSON path.
- **`vec`** — value must be an array. Each element is recursively validated as a typed argument.
  Errors from inner elements are reported with their index path prefixed (e.g.
  `args.0.value.1.value`).
- **`map`** — value must be an array of `{ key, value }` pairs. Both the key and the value of each
  entry are recursively validated as typed arguments. Errors include the entry index and `key` or
  `value` segment in the path (e.g. `args.0.value.0.key.value`).

These checks apply to both top-level arguments and arguments nested arbitrarily deep inside
`vec`/`map` structures. A deeply nested invalid `address` or `bytes` value is rejected at parse
time with the full contract/invocation/argument/index path, before any build, deployment, or
simulation step.

Primitive types whose SDK constructors accept any input without runtime error (`symbol`, `string`,
`u32`, `i32`, `bool`) are not additionally constrained beyond type-key presence.

---

## Migration

If your fixture files contain custom extension fields (fields not in the allowed list above),
remove them before upgrading.

Common patterns that will now be rejected:

| Pattern | Fix |
|---|---|
| `"comment": "..."` at any level | Remove the field; use a `// comment` in a wrapper script or README instead |
| `"label": "..."` alongside `id` | Rename to `id` if it was intended as the identity key, or remove it |
| Any camelCase variant of a known field (e.g. `wasmPath`, `functionName`) | Use the snake_case canonical name (`wasm_path`, `function_name`) |
| Any extra metadata fields added for tooling (e.g. `"owner"`, `"team"`) | Move them to a separate sidecar file outside the fixture JSON |

---

## Scope Note

The declaration objects (`FixturesSpecSchema`, `ContractSpecSchema`, `InvocationSpecSchema`,
`InvocationArgSchema`) remain strict: any unknown key at any declaration level is rejected
immediately. The typed-argument value validation described above walks `vec` and `map` elements
recursively before any side effects and reports errors with precise paths. Scalar value types
whose SDK constructors accept arbitrary input without error (`symbol`, `string`, `u32`, `i32`,
`bool`) are not additionally constrained by the schema.

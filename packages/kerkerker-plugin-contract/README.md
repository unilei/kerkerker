# @kerkerker/plugin-contract

This package is the public, framework-neutral v1 contract for Kerkerker
plugins. It is intentionally independent of Next.js, MongoDB, React, and
provider SDKs, so the same DTOs can be used by a package adapter or an HTTP
sidecar maintained in another repository.

Cross-process workers use the exported `PluginJobEvent` contract. Its JSON
Schema is `schemas/plugin-job-event.v1.schema.json`; cross-field rules that JSON
Schema cannot express, including deterministic event IDs and progress sums, are
enforced by `isPluginJobEvent`. The golden wire sample in
`fixtures/plugin-job-event.v1.valid.json` and
`fixtures/plugin-job-event.v1.invalid.json` are consumed by host and Go-service
CI to detect cross-repository drift on both accepted and rejected input.

`npm run build` creates the ESM JavaScript and declarations under `dist/`.
`npm run test:pack` installs the generated tarball into a temporary directory
and imports it, so changes cannot pass CI with missing package exports.

The host application currently keeps a compatibility copy under
`lib/plugins/types.ts`. New plugin work must use this package's stable wire
types and error envelope; host-specific adapters are migrated incrementally.

The package does not load code, read secrets, or define a registry. Trust,
approval, configuration, network allowlists, and capability selection remain
host responsibilities.

Remote runtimes may optionally declare a health endpoint, supported v1
contract versions, and an authentication method in `runtime`. The `auth.secret`
field is only the name of a host-provided secret and must also appear in
`permissions.secrets`; secret values never belong in a manifest or wire
payload. The host performs health checks and protocol negotiation before
invocation and fails closed on a missing secret or incompatible response.

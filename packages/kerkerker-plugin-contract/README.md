# @kerkerker/plugin-contract

This package is the public, framework-neutral v1 contract for Kerkerker
plugins. It is intentionally independent of Next.js, MongoDB, React, and
provider SDKs, so the same DTOs can be used by a package adapter or an HTTP
sidecar maintained in another repository.

The host application currently keeps a compatibility copy under
`lib/plugins/types.ts`. New plugin work must use this package's stable wire
types and error envelope; host-specific adapters are migrated incrementally.

The package does not load code, read secrets, or define a registry. Trust,
approval, configuration, network allowlists, and capability selection remain
host responsibilities.

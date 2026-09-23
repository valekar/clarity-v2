# Server boundary

This package contains Node-only provider and authorization adapters. The Hanko
session adapter forwards only the configured session cookie to a fixed API
origin for passive validation and returns a normalized verified identity or a
401/503 denial. It does not read application membership or grant staff access;
that remains a separate repository-backed boundary.

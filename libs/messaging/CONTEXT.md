# Synthetic message provider boundary

Input: a database-owned delivery intent with a stable idempotency key,
destination and approved message text. Output: an accepted receipt, a rejected
result, or an uncertain outcome to reconcile before any retry. The synthetic
provider has no external network effect and exists to test worker state
transitions. A real provider, signed callbacks and recipient verification remain
sharing-release work; no live credentials or patient content belong here.

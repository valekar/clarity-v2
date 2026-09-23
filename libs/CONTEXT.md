# Shared packages

Input: a real consumer in apps/. Place browser-safe visual code in ui and shared
tool configuration in config. Add domain/contracts/database/integration packages
when their first implementation increment needs them; the plan lists ownership.
Output: explicit workspace exports and checks. Review the import graph so a UI
package never reaches Node, credentials, PostgreSQL or provider SDKs.

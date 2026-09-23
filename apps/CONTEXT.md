# Application boundaries

The scaffold has four explicit app owners: web dashboard shell, Electron shell,
local sync service entry and cloud worker entry. Their current behaviour is
documented in each folder. Shared code comes from libs/ through workspace
dependencies; apps do not import one another. Verify all four builds, then test
actual provider/data behaviour only when implemented.

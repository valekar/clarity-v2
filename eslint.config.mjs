import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypeScript from "eslint-config-next/typescript";

export default defineConfig([
  ...nextCoreWebVitals,
  ...nextTypeScript,
  {
    settings: {
      react: { version: "19.3.0" },
      next: { rootDir: "apps/web" },
    },
  },
  globalIgnores(["**/.next/**", "**/dist/**", "**/node_modules/**", "**/.turbo/**"]),
]);

import { sourcePolicyViolations } from "./source-policy.ts";

const failures = sourcePolicyViolations();
if (failures.length > 0) {
  failures.forEach((failure) => process.stderr.write(`${failure}\n`));
  process.exitCode = 1;
} else {
  process.stdout.write(
    "Authored source line limits, workspace boundaries and V1 import policy pass.\n",
  );
}

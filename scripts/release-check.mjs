import { readFile } from "node:fs/promises";
const required = [
  "nimiqWalletLogin",
  "channel3Search",
  "nimiqTestnetSavings",
  "nimiqMainnetSavings",
  "bryntumLicenseCoversJudging",
  "bryntumTimeline",
  "crossAccountGoal",
  "pwaOfflineAndInstall",
  "rollbackVerified",
];
let evidence;
try {
  evidence = JSON.parse(
    await readFile(
      new URL("../docs/release-evidence.json", import.meta.url),
      "utf8",
    ),
  );
} catch {
  console.error(
    "Production release blocked: complete docs/release-evidence.json using the supplied example after credential-backed acceptance checks.",
  );
  process.exit(1);
}
const incomplete = required.filter(
  (key) => evidence[key]?.passed !== true || !evidence[key]?.evidence,
);
if (incomplete.length) {
  console.error("Production release blocked: " + incomplete.join(", "));
  process.exit(1);
}
console.log("Recorded production acceptance gates are complete.");

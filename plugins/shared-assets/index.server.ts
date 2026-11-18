import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ensureDataDirs } from "./server/plugin-data";
import { registerHandlers, runAutoSync } from "./server/service";
import { listLegacySkillProjects } from "./server/skills";
import { LEGACY_SKILL_MESSAGE } from "./server/skill-entity";

export default function contribute(server: PluginServerContext) {
  void ensureDataDirs().catch((error) => {
    console.error(
      "[paseo-shared-assets] cannot create plugin data directory",
      error,
    );
  });
  console.log(
    `[paseo-shared-assets] server starting (pid ${process.pid}, PASEO_HOME=${process.env.PASEO_HOME ?? "unset"})`,
  );
  registerHandlers(server);
  void listLegacySkillProjects()
    .then((projects) => {
      for (const projectId of projects) {
        console.warn(
          `[paseo-shared-assets] ${LEGACY_SKILL_MESSAGE} (project ${projectId})`,
        );
      }
    })
    .catch(() => {});
  const intervalMs = Number(process.env.SHARED_ASSETS_AUTO_SYNC_MS ?? "60000");
  const delay =
    Number.isFinite(intervalMs) && intervalMs >= 5000 ? intervalMs : 60_000;
  const initial = setTimeout(
    () => {
      void runAutoSync();
    },
    Math.min(delay, 10_000),
  );
  (initial as unknown as { unref?: () => void }).unref?.();
  const timer = setInterval(() => {
    void runAutoSync();
  }, delay);
  (timer as unknown as { unref?: () => void }).unref?.();
  return () => {
    clearTimeout(initial);
    clearInterval(timer);
  };
}

import { nitro } from "nitro/vite";
import vinext from "vinext";
import { defineConfig } from "vite";

const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === "seatbelt";
const ignoredGeneratedTestArtifacts = ["**/playwright-report/**", "**/test-results/**"];

export default defineConfig({
    server: isCodexSeatbeltSandbox
        ? {
              watch: {
                  ignored: ignoredGeneratedTestArtifacts,
                  useFsEvents: false,
                  usePolling: true,
              },
          }
        : { watch: { ignored: ignoredGeneratedTestArtifacts } },
    plugins: [vinext(), nitro()],
});

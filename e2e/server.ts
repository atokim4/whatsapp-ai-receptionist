import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

export interface DemoServer {
  url: string;
  stop(): Promise<void>;
}

/** Starts the built server in demo mode on a free port with a throwaway database. Run `npm run build` first. */
export async function startDemoServer(): Promise<DemoServer> {
  const dir = mkdtempSync(join(tmpdir(), "wa-receptionist-e2e-"));
  const child: ChildProcess = spawn(process.execPath, ["--disable-warning=ExperimentalWarning", "dist/main.js"], {
    env: { ...process.env, DEMO_MODE: "1", PORT: "0", HOST: "127.0.0.1", DATABASE_PATH: join(dir, "demo.db"), ANTHROPIC_API_KEY: "" },
    stdio: ["ignore", "pipe", "inherit"],
  });

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("demo server did not start in 10 s")), 10_000);
    child.once("exit", (code) => reject(new Error(`demo server exited with code ${code}`)));
    createInterface({ input: child.stdout! }).on("line", (line) => {
      const event = JSON.parse(line) as { msg?: string; url?: string };
      if (event.msg === "listening" && event.url) {
        clearTimeout(timer);
        resolve(event.url);
      }
    });
  });

  return {
    url,
    stop: () =>
      new Promise((resolve) => {
        child.once("exit", () => {
          rmSync(dir, { recursive: true, force: true });
          resolve();
        });
        child.kill("SIGTERM");
      }),
  };
}

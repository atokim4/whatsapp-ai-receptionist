import { randomBytes } from "node:crypto";
import { z } from "zod";

const flag = z
  .enum(["0", "1", "true", "false"])
  .default("0")
  .transform((v) => v === "1" || v === "true");

const envSchema = z.object({
  PORT: z.coerce.number().int().min(0).max(65535).default(3000),
  HOST: z.string().min(1).default("127.0.0.1"),
  DATABASE_PATH: z.string().min(1).default("./data/receptionist.db"),

  WHATSAPP_VERIFY_TOKEN: z.string({ error: "WHATSAPP_VERIFY_TOKEN is required" }).min(8, "WHATSAPP_VERIFY_TOKEN must be at least 8 characters"),
  WHATSAPP_APP_SECRET: z.string({ error: "WHATSAPP_APP_SECRET is required" }).min(1, "WHATSAPP_APP_SECRET is required"),
  WHATSAPP_ACCESS_TOKEN: z.string({ error: "WHATSAPP_ACCESS_TOKEN is required" }).min(1, "WHATSAPP_ACCESS_TOKEN is required"),
  WHATSAPP_PHONE_NUMBER_ID: z.string({ error: "WHATSAPP_PHONE_NUMBER_ID is required" }).regex(/^\d+$/, "WHATSAPP_PHONE_NUMBER_ID must be numeric"),
  GRAPH_API_BASE: z.url().default("https://graph.facebook.com"),
  GRAPH_API_VERSION: z.string().regex(/^v\d+\.\d+$/).default("v24.0"),
  /** Approved template sent when the 24-hour customer service window is closed. */
  WHATSAPP_TEMPLATE_NAME: z.string().min(1).default("hello_world"),
  WHATSAPP_TEMPLATE_LANG: z.string().min(2).default("en_US"),

  ANTHROPIC_API_KEY: z.string().optional(),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-haiku-5-5"),
  LLM_EFFORT: z.enum(["low", "medium", "high"]).default("low"),

  /** Staff dashboard at /admin (HTTP basic auth). Disabled when no password is set. */
  ADMIN_USER: z.string().min(1).default("admin"),
  ADMIN_PASSWORD: z.string().min(8, "ADMIN_PASSWORD must be at least 8 characters").optional(),

  /** Local demo: phone simulator at /simulator, outbound messages captured in memory, offline demo model. */
  DEMO_MODE: flag,

  CLINIC_TIMEZONE: z.string().min(1).default("Europe/Berlin"),
  RATE_LIMIT_PER_MINUTE: z.coerce.number().int().positive().default(8),
});

export type Config = z.infer<typeof envSchema>;

/**
 * In demo mode nothing talks to Meta, so the WhatsApp credentials get throwaway values. The app secret is
 * random per process: the simulator signs its webhooks on the server and never sends the secret to the page.
 */
function demoDefaults(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    WHATSAPP_VERIFY_TOKEN: randomBytes(12).toString("hex"),
    WHATSAPP_APP_SECRET: randomBytes(32).toString("hex"),
    WHATSAPP_ACCESS_TOKEN: "demo-mode-no-graph-calls",
    WHATSAPP_PHONE_NUMBER_ID: "100000000000001",
    ADMIN_PASSWORD: "demo-admin",
    DATABASE_PATH: "./data/demo.db",
    RATE_LIMIT_PER_MINUTE: "20",
    ...env,
  };
}

export function loadConfig(rawEnv: NodeJS.ProcessEnv = process.env): Config {
  // `KEY=` in an .env file means "not set", not an empty value.
  const env = Object.fromEntries(Object.entries(rawEnv).filter(([, v]) => v !== undefined && v !== ""));
  const demo = env.DEMO_MODE === "1" || env.DEMO_MODE === "true";
  const parsed = envSchema.safeParse(demo ? demoDefaults(env) : env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    throw new Error(`Invalid configuration:\n${problems}`);
  }
  assertTimeZone(parsed.data.CLINIC_TIMEZONE);
  return parsed.data;
}

function assertTimeZone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en", { timeZone: tz });
  } catch {
    throw new Error(`Invalid configuration:\n  - CLINIC_TIMEZONE: unknown time zone "${tz}"`);
  }
}

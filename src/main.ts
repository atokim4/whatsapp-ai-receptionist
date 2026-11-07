import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import Anthropic from "@anthropic-ai/sdk";
import express from "express";
import { adminRouter } from "./admin/routes.js";
import { runAgent } from "./agent/agent.js";
import { AnthropicLlm, type LlmClient } from "./agent/llm.js";
import { BookingService } from "./clinic/booking.js";
import { sampleClinic } from "./clinic/sample-clinic.js";
import { loadConfig } from "./config.js";
import { DemoLlm } from "./demo/demo-llm.js";
import { DemoOutbox } from "./demo/outbox.js";
import { simulatorRouter } from "./demo/simulator.js";
import { errorMessage, jsonLogger } from "./logger.js";
import { RateLimiter } from "./rate-limit.js";
import { Receptionist } from "./receptionist.js";
import { createApp } from "./server.js";
import { Store } from "./store.js";
import { GraphClient, type WhatsAppSender } from "./whatsapp/graph.js";
import { Messenger } from "./whatsapp/messenger.js";

const logger = jsonLogger();
const publicDir = fileURLToPath(new URL("../public", import.meta.url));

function main(): void {
  const config = loadConfig();
  const now = () => new Date();
  const store = new Store(config.DATABASE_PATH);
  const clinic = sampleClinic(config.CLINIC_TIMEZONE);
  const bookings = new BookingService(clinic, store, now);

  // Demo mode captures outbound messages in memory instead of calling the Graph API.
  const outbox = config.DEMO_MODE ? new DemoOutbox(now) : null;
  const sender: WhatsAppSender =
    outbox ??
    new GraphClient({
      baseUrl: config.GRAPH_API_BASE,
      version: config.GRAPH_API_VERSION,
      phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: config.WHATSAPP_ACCESS_TOKEN,
    });
  const messenger = new Messenger(
    sender,
    store,
    { templateName: config.WHATSAPP_TEMPLATE_NAME, templateLanguage: config.WHATSAPP_TEMPLATE_LANG },
    now,
  );

  const useDemoModel = config.DEMO_MODE && !config.ANTHROPIC_API_KEY;
  const llm: LlmClient = useDemoModel ? new DemoLlm(clinic) : new AnthropicLlm(new Anthropic({ apiKey: config.ANTHROPIC_API_KEY }));
  const agentOptions = { llm, model: config.ANTHROPIC_MODEL, effort: config.LLM_EFFORT, logger };

  const receptionist = new Receptionist({
    store,
    clinic,
    bookings,
    messenger,
    rateLimiter: new RateLimiter(config.RATE_LIMIT_PER_MINUTE),
    agent: (input) => runAgent(agentOptions, input),
    logger,
    now,
  });

  const app = createApp({
    verifyToken: config.WHATSAPP_VERIFY_TOKEN,
    appSecret: config.WHATSAPP_APP_SECRET,
    phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
    onMessages: (messages) => receptionist.accept(messages),
    logger,
    mount: (app) => {
      app.use("/assets", express.static(publicDir, { index: false, maxAge: "1h" }));
      if (config.ADMIN_PASSWORD) {
        app.use("/admin", adminRouter({ store, clinic, messenger, user: config.ADMIN_USER, password: config.ADMIN_PASSWORD, publicDir, logger, now }));
      }
      if (outbox) {
        app.use(
          "/simulator",
          simulatorRouter({
            outbox,
            appSecret: config.WHATSAPP_APP_SECRET,
            phoneNumberId: config.WHATSAPP_PHONE_NUMBER_ID,
            clinicName: clinic.name,
            model: useDemoModel ? "demo" : "claude",
            publicDir,
            logger,
          }),
        );
        app.get("/", (_req, res) => res.redirect("/simulator"));
      }
    },
  });

  const server = app.listen(config.PORT, config.HOST, () => {
    const { port } = server.address() as AddressInfo;
    logger.info("listening", {
      url: `http://${config.HOST}:${port}`,
      demo: config.DEMO_MODE,
      model: useDemoModel ? "offline demo model" : config.ANTHROPIC_MODEL,
      admin: config.ADMIN_PASSWORD ? "/admin" : "disabled (set ADMIN_PASSWORD)",
      ...(config.DEMO_MODE ? { simulator: "/simulator", adminLogin: `${config.ADMIN_USER} / see ADMIN_PASSWORD (demo default: demo-admin)` } : {}),
    });
  });
  server.on("error", (err) => {
    logger.error("server error", { error: errorMessage(err) });
    process.exit(1);
  });

  const shutdown = (signal: string) => {
    logger.info("shutting down", { signal });
    server.close(() => {
      void receptionist.idle().finally(() => {
        store.close();
        process.exit(0);
      });
    });
  };
  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

try {
  main();
} catch (err) {
  logger.error("startup failed", { error: errorMessage(err) });
  process.exit(1);
}

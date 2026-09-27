/**
 * Guided setup wizard: provider keys, default model, permission mode,
 * Discord/WhatsApp enablement. Writes ~/.zcode-ultra/config.json atomically.
 */
import readline from "node:readline";
import fs from "node:fs";
import { saveGlobalConfig, BUILTIN_PROVIDERS, configDirExample, type Config } from "../config/config.js";
import { colors as C, dataHome } from "../util.js";

function ask(rl: readline.Interface, question: string, fallback = ""): Promise<string> {
  return new Promise((resolve) => {
    const hint = fallback ? C.dim(` (${fallback})`) : "";
    rl.question(`${question}${hint}: `, (answer) => {
      resolve(answer.trim() || fallback);
    });
  });
}

export async function runSetup(cfg: Config): Promise<void> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`${C.bold("ZCode Ultra setup")}\nConfig file: ${configDirExample()}\n`);

  console.log("Built-in providers:");
  const ids = Object.keys(BUILTIN_PROVIDERS);
  ids.forEach((id, i) => console.log(`  ${i + 1}. ${id.padEnd(10)} ${BUILTIN_PROVIDERS[id]!.model ?? ""}`));

  const providerId = await ask(rl, "\nDefault provider id", "zai");
  const envName = BUILTIN_PROVIDERS[providerId]?.apiKeyEnv;
  const apiKey = await ask(rl, `API key for ${providerId}${envName ? ` (stored as ${envName} env in config)` : ""}`, "");
  const model = await ask(rl, `Default model`, BUILTIN_PROVIDERS[providerId]?.model ?? "");
  const fallback = await ask(rl, "Fallback chain (comma-separated provider/model, empty = none)", "");
  const mode = (await ask(rl, "Permission mode [default|acceptEdits|yolo|plan]", "default")) as Config["permissionMode"];

  const next: Config = structuredClone(cfg);
  if (!next.providers[providerId] && BUILTIN_PROVIDERS[providerId]) {
    next.providers[providerId] = { ...BUILTIN_PROVIDERS[providerId]! };
  }
  if (apiKey) {
    next.providers[providerId] = { ...next.providers[providerId], apiKey };
  }
  next.model = `${providerId}/${model}`;
  if (fallback) next.fallbackModels = fallback.split(",").map((s) => s.trim()).filter(Boolean);
  if (["default", "acceptEdits", "yolo", "plan"].includes(mode)) next.permissionMode = mode;

  const discordToken = await ask(rl, "Discord bot token (empty = skip)", "");
  if (discordToken) {
    next.discord = { ...next.discord, enabled: true };
    const envFile = dataHome();
    console.log(C.dim(`\nPut this in your shell profile:  export ZCODE_ULTRA_DISCORD_TOKEN="${discordToken}"`));
    void envFile;
  }

  const wa = await ask(rl, "Enable WhatsApp? [baileys|cloud|off]", "off");
  if (["baileys", "cloud"].includes(wa)) {
    next.whatsapp = { ...next.whatsapp, enabled: true, mode: wa as Config["whatsapp"]["mode"] };
  }

  const file = saveGlobalConfig(next);
  console.log(C.green(`\nSaved ${file}`));
  console.log(`Test with:  zcode-ultra doctor\nChat with:  zcode-ultra`);
  rl.close();
  void fs;
}

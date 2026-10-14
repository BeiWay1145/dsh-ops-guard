// src/index.ts
import { fileURLToPath } from "node:url";
import { dirname, join as join2 } from "node:path";

// src/segment.ts
function splitSubcommands(command) {
  const segments = [];
  let current = "";
  let quote = "none";
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (quote === "single") {
      current += ch;
      if (ch === "'") quote = "none";
      continue;
    }
    if (quote === "double") {
      if (ch === "\\") {
        current += ch;
        if (i + 1 < command.length) {
          current += command[i + 1];
          i += 1;
        }
        continue;
      }
      current += ch;
      if (ch === '"') quote = "none";
      continue;
    }
    if (ch === "\\") {
      current += ch;
      if (i + 1 < command.length) {
        current += command[i + 1];
        i += 1;
      }
      continue;
    }
    if (ch === '"') {
      quote = "double";
      current += ch;
      continue;
    }
    if (ch === "'") {
      quote = "single";
      current += ch;
      continue;
    }
    if (ch === "|" || ch === "&") {
      const next = command[i + 1];
      if (next === ch) {
        segments.push(current);
        current = "";
        i += 1;
        continue;
      }
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === ";") {
      segments.push(current);
      current = "";
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      segments.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  segments.push(current);
  return segments.map((s) => s.trim()).filter((s) => s !== "");
}

// src/detect.ts
var SHELL_TOOLS = /* @__PURE__ */ new Set(["pwsh", "bash", "shell"]);
function commandOf(args) {
  if (args === null || typeof args !== "object") return "";
  const command = args.command;
  return typeof command === "string" ? command : "";
}
function detectInCommand(command) {
  if (command === "") return void 0;
  const code = stripComments(command);
  if (code === "") return void 0;
  for (const segment of splitSubcommands(code)) {
    const hit = detectInSegment(segment);
    if (hit !== void 0) return hit;
  }
  return void 0;
}
var NULL_TARGETS = /* @__PURE__ */ new Set(["-", "/dev/null", "/dev/stdout", "/dev/stderr", "nul", "$null"]);
function unquote(s) {
  const t = s.trim();
  if (t.length >= 2) {
    const first = t[0];
    const last = t[t.length - 1];
    if (first === '"' && last === '"' || first === "'" && last === "'") {
      return t.slice(1, -1);
    }
  }
  return t;
}
function curlWritesFile(segment) {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "-O" || tok === "--remote-name" || tok === "--remote-name-all") return true;
    if (/^-[A-Za-z]*O[A-Za-z]*$/.test(tok)) return true;
    if (tok.startsWith("--output=")) {
      return !NULL_TARGETS.has(unquote(tok.slice("--output=".length)).toLowerCase());
    }
    if (tok === "--output") {
      const next = tokens[i + 1];
      if (next === void 0) return true;
      return !NULL_TARGETS.has(unquote(next).toLowerCase());
    }
    if (tok === "-o") {
      const next = tokens[i + 1];
      if (next === void 0) return true;
      return !NULL_TARGETS.has(unquote(next).toLowerCase());
    }
    if (/^-o./.test(tok)) {
      return !NULL_TARGETS.has(unquote(tok.slice(2)).toLowerCase());
    }
  }
  return false;
}
function wgetWritesStdout(segment) {
  const tokens = segment.split(/\s+/).filter((t) => t !== "");
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i];
    if (tok === "--output-document=-") return true;
    if (tok === "--output-document") {
      const next = tokens[i + 1];
      if (next !== void 0 && unquote(next) === "-") return true;
      continue;
    }
    if (/^-[A-Za-z]*O$/.test(tok)) {
      const next = tokens[i + 1];
      if (next !== void 0 && unquote(next) === "-") return true;
      continue;
    }
    if (/^-[A-Za-z]*O-$/.test(tok)) return true;
  }
  return false;
}
function detectInSegment(segment) {
  if (/\bcurl\b/.test(segment) && curlWritesFile(segment)) {
    return { rule: "curl-output", url: firstUrl(segment) };
  }
  if (/\bwget\b/.test(segment) && !wgetWritesStdout(segment)) {
    return { rule: "wget", url: firstUrl(segment) };
  }
  if (/\b(Invoke-WebRequest|iwr)\b/.test(segment) && /-OutFile(\s|$|:)/i.test(segment)) {
    return { rule: "Invoke-WebRequest", url: firstUrl(segment) };
  }
  if (/\bInvoke-RestMethod\b/i.test(segment) && /-OutFile(\s|$|:)/i.test(segment)) {
    return { rule: "Invoke-RestMethod", url: firstUrl(segment) };
  }
  if (/\bStart-BitsTransfer\b/i.test(segment)) {
    return { rule: "Start-BitsTransfer", url: firstUrl(segment) };
  }
  return void 0;
}
function stripComments(command) {
  return command.split(/\r?\n/).map((line) => {
    const hash = line.indexOf("#");
    if (hash < 0) return line;
    const before = line.slice(0, hash);
    const quotes = (before.match(/"/g) ?? []).length + (before.match(/'/g) ?? []).length;
    if (quotes % 2 === 1) return line;
    if (before.trim() === "") return "";
    if (/\s$/.test(before)) return before;
    return line;
  }).join("\n").trim();
}
function isShellTool(name) {
  return SHELL_TOOLS.has(name);
}
function firstUrl(command) {
  const m = /https?:\/\/[^\s'"`)]+/.exec(command);
  return m === null ? void 0 : m[0];
}
function inspect(name, args) {
  if (!isShellTool(name)) return void 0;
  return detectInCommand(commandOf(args));
}

// src/search.ts
var SEARCH_TOOL = "glob";
function globArgsOf(args) {
  if (args === null || typeof args !== "object") return void 0;
  const raw = args;
  if (typeof raw.pattern !== "string" || raw.pattern.trim() === "") return void 0;
  const out = { pattern: raw.pattern };
  if (typeof raw.path === "string" && raw.path.trim() !== "") out.path = raw.path;
  return out;
}
function inspectSearch(name, args) {
  if (name !== SEARCH_TOOL) return void 0;
  const parsed = globArgsOf(args);
  if (parsed === void 0) return void 0;
  return { rule: "glob", pattern: parsed.pattern, path: parsed.path };
}
function esArgvFor(hit, defaultRoot) {
  const translated = translateToEsPattern(hit.pattern, hit.path ?? defaultRoot);
  const argv = ["-n", "50"];
  if (translated.root !== void 0 && translated.root !== "") argv.push("-path", translated.root);
  argv.push(translated.pattern);
  return argv;
}
function translateToEsPattern(pattern, root) {
  const STAR = "**/";
  const at = pattern.indexOf(STAR);
  if (at === -1) return { pattern, root };
  const prefix = pattern.slice(0, at);
  const rest = pattern.slice(at + STAR.length);
  if (rest === "") return { pattern, root };
  if (/[*?[\]]/.test(prefix)) return { pattern, root };
  const dir = prefix.replace(/[/\\]+$/, "");
  if (dir === "") return { pattern: rest, root };
  const joined = root === void 0 || root === "" ? dir : root.replace(/[/\\]+$/, "") + "/" + dir;
  return { pattern: rest, root: joined };
}
function shellQuote(arg) {
  if (arg !== "" && !/[\s"'$&|;<>()^*?\[\]{}!#~`]/.test(arg)) return arg;
  return '"' + arg.replace(/"/g, '\\"') + '"';
}
function renderCommand(exe, argv) {
  return [exe, ...argv].map(shellQuote).join(" ");
}
function searchDenialMessage(hit, esPath, defaultRoot) {
  const argv = esArgvFor(hit, defaultRoot);
  const lines = [
    "BLOCKED by dsh-ops-guard: use Everything (es.exe) for file search instead",
    "(matched: " + hit.rule + "). Everything keeps a real-time index of every file,",
    "so the same query answers in milliseconds instead of walking the tree.",
    ""
  ];
  if (esPath === void 0) {
    lines.push(
      "es.exe was not found on PATH, so no replacement command can be given.",
      "Install Everything + es.exe (voidtools.com), or use the grep tool, whose",
      "content search is unaffected by this guard."
    );
  } else {
    lines.push("Use instead:", "  " + renderCommand(esPath, argv), "");
    lines.push(
      "Options: -n <count> to change the result cap, -json for machine-readable",
      "output, -path <dir> to change the root. es.exe speaks the same pattern",
      "language, including ** for recursive matches."
    );
  }
  lines.push(
    "",
    "The grep tool is NOT affected: content search stays on the built-in tool."
  );
  return lines.join("\n");
}
function searchAnsweredMessage(hit, result, elapsedMs, esPath, defaultRoot) {
  const shown = result.records.slice(0, 50);
  const lines = [
    "BLOCKED by dsh-ops-guard: the built-in glob tool was not run.",
    "(matched: " + hit.rule + " \u2014 pattern " + JSON.stringify(hit.pattern) + (hit.path === void 0 ? "" : ", path " + JSON.stringify(hit.path)) + ")",
    "",
    "Everything already answered this query over its resident IPC pipe in " + elapsedMs.toFixed(1) + " ms, so there is nothing for you to run:",
    "",
    "  total matches: " + result.total + (result.total > shown.length ? "   (showing first " + shown.length + ")" : "")
  ];
  if (shown.length === 0) {
    lines.push("", "  (no files matched)");
  } else {
    lines.push("");
    for (const rec of shown) lines.push("  " + (rec.directory ? "[dir] " : "      ") + rec.path);
  }
  lines.push(
    "",
    "If you need a DIFFERENT query, es.exe speaks the same pattern language:",
    "  " + renderCommand(esPath ?? "es.exe", esArgvFor(hit, defaultRoot)),
    "",
    "The grep tool is NOT affected: content search stays on the built-in tool."
  );
  return lines.join("\n");
}
function buildEverythingQuery(pattern, root, workspace) {
  const translated = translateToEsPattern(pattern, root ?? workspace);
  let scope = translated.root;
  if (scope === void 0 || scope === "") return translated.pattern;
  const isAbsolute = /^[A-Za-z]:[\\/]/.test(scope) || scope.startsWith("\\\\");
  if (!isAbsolute) {
    if (workspace === void 0 || workspace === "") return translated.pattern;
    const trimmed = scope.replace(/^[.][\\/]?/, "").replace(/[\\/]+$/, "");
    const base = workspace.replace(/[\\/]+$/, "");
    scope = trimmed === "" ? base : base + "\\" + trimmed;
  }
  return "path:" + scope + " " + translated.pattern;
}

// src/es.ts
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
var ES_NAMES_WIN32 = ["es.exe"];
var ES_NAMES_POSIX = ["es"];
function candidateDirs(env, platform) {
  const dirs = [];
  const pathValue = env.PATH ?? env.Path ?? "";
  const sep = platform === "win32" ? ";" : ":";
  for (const entry of pathValue.split(sep)) {
    if (entry.trim() !== "") dirs.push(entry.trim());
  }
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (home !== "") dirs.push(join(home, "bin"));
  const programFiles = env.ProgramFiles ?? env.PROGRAMFILES ?? "C:\\Program Files";
  dirs.push(join(programFiles, "Everything"));
  const programFilesX86 = env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
  dirs.push(join(programFilesX86, "Everything"));
  dirs.push("C:\\Program Files\\Everything");
  dirs.push("D:\\Everything");
  dirs.push("C:\\Everything");
  return dirs;
}
function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
function findEsExe(options = {}) {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const names = platform === "win32" ? ES_NAMES_WIN32 : ES_NAMES_POSIX;
  const exists = options.exists ?? existsSync;
  const isFileCheck = options.isFile ?? isFile;
  try {
    for (const dir of candidateDirs(env, platform)) {
      if (dir === "") continue;
      for (const name of names) {
        const p = join(dir, name);
        if (exists(p) && isFileCheck(p)) return p;
      }
    }
  } catch {
  }
  return void 0;
}

// src/everything-ipc.ts
import net from "node:net";
var EVERYTHING_PIPE = "\\\\.\\PIPE\\Everything IPC";
var CMD_SEARCH = 7;
var STATUS_MORE = 100;
var STATUS_FINAL = 200;
var DEFAULT_TIMEOUT_MS = 5e3;
function encodeVarint(n) {
  if (!Number.isFinite(n) || n < 0) throw new Error("varint expects a non-negative finite number, got " + n);
  if (n < 255) return Buffer.from([n]);
  if (n < 65535) {
    const b2 = Buffer.alloc(3);
    b2[0] = 255;
    b2.writeUInt16LE(n - 255, 1);
    return b2;
  }
  const b = Buffer.alloc(7);
  b[0] = 255;
  b.writeUInt16LE(65535, 1);
  b.writeUInt32LE(n - 65535, 3);
  return b;
}
function buildSearchPayload(query, offset = 0, count = 50, flags = 16384) {
  const q = Buffer.from(query, "utf8");
  const off = Buffer.alloc(8);
  off.writeBigUInt64LE(BigInt(offset), 0);
  const cnt = Buffer.alloc(8);
  cnt.writeBigUInt64LE(BigInt(count), 0);
  const head = Buffer.alloc(4);
  head.writeUInt32LE(flags, 0);
  return Buffer.concat([head, encodeVarint(q.length), q, off, cnt, Buffer.alloc(4), encodeVarint(0)]);
}
function makeCursor(buf) {
  let o = 0;
  const need = (n) => {
    if (o + n > buf.length) throw new Error("reply truncated at " + o + ", need " + n);
  };
  return {
    get pos() {
      return o;
    },
    u8() {
      need(1);
      return buf[o++];
    },
    u32() {
      need(4);
      const v = buf.readUInt32LE(o);
      o += 4;
      return v;
    },
    u64() {
      need(8);
      const v = buf.readBigUInt64LE(o);
      o += 8;
      return v;
    },
    varint() {
      const b = this.u8();
      if (b !== 255) return b;
      need(2);
      const v16 = buf.readUInt16LE(o);
      o += 2;
      if (v16 !== 65535) return 255 + v16;
      const v32 = this.u32();
      if (v32 < 4294967294) return 65535 + v32;
      return Number(this.u64());
    }
  };
}
function decodeReply(body) {
  const c = makeCursor(body);
  const flags = c.u32();
  const wide = (flags >> 14 & 1) !== 0;
  const extra = (flags >> 11 & 1) !== 0;
  const readSized = () => wide ? Number(c.u64()) : c.u32();
  readSized();
  const total = readSized();
  if (extra) c.u64();
  readSized();
  readSized();
  const descCount = c.varint();
  for (let i = 0; i < descCount; i += 1) {
    c.u32();
    c.u32();
  }
  const fieldCount = c.varint();
  for (let i = 0; i < fieldCount; i += 1) {
    c.u32();
    c.u32();
    c.u8();
  }
  const records = [];
  while (c.pos < body.length) {
    const recordFlags = c.u8();
    const len = c.varint();
    if (len === 0 || len > body.length - c.pos) break;
    const start = c.pos;
    for (let i = 0; i < len; i += 1) c.u8();
    records.push({
      path: body.subarray(start, start + len).toString("utf8"),
      directory: (recordFlags & 1) === 1
    });
  }
  return { total, records };
}
async function searchEverything(query, options = {}) {
  const {
    offset = 0,
    count = 50,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    pipe = EVERYTHING_PIPE
  } = options;
  const payload = buildSearchPayload(query, offset, count);
  return await new Promise((resolve, reject) => {
    const sock = net.connect(pipe);
    let buf = Buffer.alloc(0);
    const frames = [];
    let settled = false;
    const finish = (fn) => {
      if (!settled) {
        settled = true;
        try {
          sock.destroy();
        } catch {
        }
        ;
        fn();
      }
    };
    const timer = setTimeout(() => finish(() => reject(new Error("Everything IPC timed out after " + timeoutMs + "ms"))), timeoutMs);
    sock.on("connect", () => {
      const head = Buffer.alloc(8);
      head.writeInt32LE(CMD_SEARCH, 0);
      head.writeInt32LE(payload.length, 4);
      sock.write(Buffer.concat([head, payload]));
    });
    sock.on("data", (d) => {
      buf = Buffer.concat([buf, d]);
      while (buf.length >= 8) {
        const status = buf.readInt32LE(0);
        const len = buf.readInt32LE(4);
        if (buf.length < 8 + len) return;
        const body = buf.subarray(8, 8 + len);
        buf = buf.subarray(8 + len);
        if (status === STATUS_MORE) {
          frames.push(body);
          continue;
        }
        if (status !== STATUS_FINAL) {
          clearTimeout(timer);
          return finish(() => reject(new Error("Everything IPC rejected the request with status " + status)));
        }
        frames.push(body);
        clearTimeout(timer);
        try {
          const decoded = decodeReply(Buffer.concat(frames));
          finish(() => resolve(decoded));
        } catch (error) {
          finish(() => reject(error instanceof Error ? error : new Error(String(error))));
        }
        return;
      }
    });
    sock.on("error", (err) => {
      clearTimeout(timer);
      finish(() => reject(new Error("Everything IPC unavailable: " + (err.code ?? err.message))));
    });
  });
}

// src/index.ts
var PLUGIN_NAME = "dsh-ops-guard";
function forwarderPath() {
  try {
    return join2(dirname(fileURLToPath(import.meta.url)), "..", "scripts", "aria2-dl.cjs");
  } catch {
    return "aria2-dl.cjs";
  }
}
function denialMessage(rule, url, command) {
  const target = url === void 0 ? "<URL>" : url;
  const lines = [
    "BLOCKED by " + PLUGIN_NAME + ": this command downloads a file to disk",
    "(matched: " + rule + "), and downloads must go through the local aria2 engine",
    "(Motrix Next) so they are multithreaded, resumable and visible in the download manager.",
    "",
    "Use instead:",
    '  node "' + forwarderPath() + '" "' + target + '" --out=<filename>',
    "",
    'Options: --dir=<dir> for the destination, --header="K: V" for headers,',
    "--no-wait to enqueue and return immediately (then query with --status <gid>).",
    "A blocked command is never partially executed."
  ];
  const shown = command.length > 240 ? command.slice(0, 240) + "..." : command;
  lines.push("", "Blocked command: " + shown);
  return lines.join("\n");
}
function apply(ctx) {
  let esPath;
  try {
    esPath = findEsExe();
  } catch {
    esPath = void 0;
  }
  ctx.on("tools/pre-execute", async (exec, next) => {
    let hit;
    try {
      const name = typeof exec?.name === "string" ? exec.name : "";
      hit = inspect(name, exec?.arguments);
    } catch {
      return next();
    }
    if (hit !== void 0) {
      const args = exec?.arguments;
      const command = typeof args?.command === "string" ? args.command : "";
      const reason = denialMessage(hit.rule, hit.url, command);
      try {
        ctx.logger?.info(PLUGIN_NAME + ": blocked " + hit.rule + (hit.url === void 0 ? "" : " (" + hit.url + ")"));
      } catch {
      }
      return { kind: "deny", reason };
    }
    let searchHit;
    try {
      const name = typeof exec?.name === "string" ? exec.name : "";
      const workspace = workspaceRootOf(exec);
      searchHit = inspectSearch(name, exec?.arguments);
      if (searchHit !== void 0) {
        let reason;
        {
          const started = Date.now();
          try {
            const effectiveRoot = searchHit.path ?? workspace;
            const query = buildEverythingQuery(searchHit.pattern, effectiveRoot, workspace);
            const answer = await searchEverything(query, { count: 50, timeoutMs: 2500 });
            reason = searchAnsweredMessage(
              searchHit,
              answer,
              Date.now() - started,
              esPath,
              workspace
            );
            try {
              ctx.logger?.info(
                PLUGIN_NAME + ": answered " + searchHit.rule + " over IPC in " + (Date.now() - started) + "ms (" + answer.total + " matches)"
              );
            } catch {
            }
          } catch {
            reason = void 0;
          }
        }
        if (reason === void 0) {
          reason = searchDenialMessage(searchHit, esPath, workspace);
          try {
            ctx.logger?.info(
              PLUGIN_NAME + ": redirected " + searchHit.rule + " -> es.exe" + (esPath === void 0 ? " (es.exe NOT FOUND)" : "")
            );
          } catch {
          }
        }
        return { kind: "deny", reason };
      }
    } catch {
      return next();
    }
    return next();
  });
}
function workspaceRootOf(exec) {
  try {
    const anyExec = exec;
    const cwd = anyExec.agent?.session?.header?.cwd;
    return typeof cwd === "string" && cwd !== "" ? cwd : void 0;
  } catch {
    return void 0;
  }
}
export {
  PLUGIN_NAME,
  apply,
  denialMessage
};

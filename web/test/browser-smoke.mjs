// Browser smoke test for all three modes, against a running scripts/serve.py.
//
// Usage: CHROME=<chrome or chrome-headless-shell> [PLAYWRIGHT_CORE=<path to playwright-core>] \
//          node web/test/browser-smoke.mjs [base-url]   (default http://127.0.0.1:8000/)
// Needs the playwright-core npm package (resolved from PLAYWRIGHT_CORE if set).
// Exit status 1 if any check fails.

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const web = join(dirname(fileURLToPath(import.meta.url)), "..");
const base = process.argv[2] ?? "http://127.0.0.1:8000/";
const playwright = process.env.PLAYWRIGHT_CORE
  ? await import(pathToFileURL(join(process.env.PLAYWRIGHT_CORE, "index.mjs")).href)
  : await import("playwright-core");
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROME, args: ["--no-sandbox"] });

let failures = 0;
const check = (name, ok, detail = "") => {
  if (!ok) failures += 1;
  console.log(`${ok ? "ok  " : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, ms = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (await predicate()) return true;
    await sleep(100);
  }
  return false;
}

const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("dialog", (d) => d.accept());
const fileNames = () => page.$$eval("#files a", (as) => as.map((a) => a.textContent));
const ready = (selector = ".plain-in") => until(async () => !!(await page.$(`${selector}:not([disabled])`)));
async function command(text) {
  await page.fill(".plain-in", text);
  await page.press(".plain-in", "Enter");
  await sleep(50);
  await ready();
}
// Drops files on the page as a user dragging them from the desktop would.
async function dropFiles(files) {
  await page.evaluate((files) => {
    const transfer = new DataTransfer();
    for (const [name, text] of files) transfer.items.add(new File([text], name, { type: "text/plain" }));
    for (const type of ["dragenter", "dragover", "drop"]) {
      document.body.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: transfer }));
    }
  }, files);
}
const demo = (name) => [name, readFileSync(join(web, "pkg/demos", name), "utf8")];

// ---- Plain ----
await page.goto(`${base}?mode=plain`);
check("plain: REPL starts", await ready());
await dropFiles([demo("two-of-three.opb"), demo("two-of-three.pbp")]);
check("plain: dropped files listed", await until(async () => (await fileNames()).includes("two-of-three.pbp")));
await command(":instance two-of-three");
await command(":verify");
const plainOut = await page.textContent(".plain-out");
check("plain: :verify", plainOut.includes("Verified 4 line(s)."));
check("plain: veripb output folded", (await page.$$(".plain-out details.trace")).length === 1);
await page.type(".plain-in", ":ve");
await sleep(150);
check("plain: no suggestion strip", (await page.$$(".suggest")).length === 0);
await page.fill(".plain-in", "");

// ---- Classic ----
await page.selectOption("#mode", "classic");
const screen = () => page.evaluate(() => [...document.querySelectorAll(".xterm-rows > div")].map((r) => r.textContent).join("\n"));
check("classic: TUI draws", await until(async () => (await screen()).includes("pbp>")));
check("classic: files carried over", (await fileNames()).includes("two-of-three.pbp"));
await page.click(".classic-term");
await page.keyboard.type(":instance two-of-three\n:verify\n", { delay: 5 });
check("classic: :verify", await until(async () => (await screen()).includes("Verified 4 line")));

// ---- Enhanced ----
await page.selectOption("#mode", "enhanced");
check("enhanced: REPL starts", await ready());
check("enhanced: files carried over", (await fileNames()).includes("two-of-three.pbp"));
await dropFiles([demo("chain.opb"), demo("chain.pbp")]);
check("enhanced: dropped files listed", await until(async () => (await fileNames()).includes("chain.pbp")));
await command(":instance chain");
await command(":verify");
const title = (pane) => page.textContent(`.pane-${pane} .pane-title-text`);
check("enhanced: formula title", (await title("formula")) === "Formula: chain.opb (5)", await title("formula"));
check("enhanced: proof title", (await title("proof")) === "Proof (3) (3 unchecked)", await title("proof"));
const statuses = await page.$$eval(".pane-proof .row:not(.preamble) .status", (s) => s.map((x) => x.textContent).join(""));
check("enhanced: proof statuses", statuses === "✗○○", statuses);
check("enhanced: database rows", (await page.$$(".pane-database .pane-body .row")).length === 5);
const outputBefore = await page.textContent(".plain-out");
await page.hover(".pane-proof .row.rejected");
await page.click(".pane-proof .row.rejected .row-action");
check("enhanced: explain opens a modal", await until(async () => (await page.textContent(".explain-body")).includes("Line 3 is rejected")),
  (await page.textContent(".explain-body")).slice(0, 80));
check("enhanced: explain modal leaves Output alone", (await page.textContent(".plain-out")) === outputBefore);
check("enhanced: a rejected line has no plain-English view", await page.$eval(".explain-views", (e) => e.hidden));
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });
await page.keyboard.press("Escape");
check("enhanced: Esc closes the modal", await until(async () => !(await page.$eval(".explain-modal", (d) => d.open))));
await command(":explain 3");
check("enhanced: :explain still prints to Output", (await page.textContent(".plain-out")).endsWith("ConstraintId 1: @x1_or_x2 1 x1 1 x2 >= 1\n"));
await page.fill(".db-filter", "@x3_imp");
await sleep(100);
const filtered = await page.$$eval(".pane-database .pane-body .row .text", (r) => r.map((x) => x.textContent));
check("enhanced: database filter", filtered.length === 2 && filtered.every((t) => t.includes("@x3_imp")), (await title("database")));
await page.fill(".db-filter", "");
await page.fill(".formula-filter", "x3_imp");
await sleep(100);
check("enhanced: formula filter", (await page.$$(".pane-formula .pane-body .row")).length === 2, await title("formula"));
await page.fill(".formula-filter", "2");
await sleep(100);
const byId = await page.$$eval(".pane-formula .pane-body .row .num", (n) => n.map((x) => x.textContent));
check("enhanced: formula filter by id", byId.join() === "2", byId.join());
await page.fill(".formula-filter", "");
await page.fill(".proof-filter", "@not_x3");
await sleep(100);
const proofRows = await page.$$eval(".pane-proof .pane-body .row .num", (n) => n.map((x) => x.textContent));
check("enhanced: proof filter", proofRows.join() === "4,5" && (await title("proof")).startsWith("Proof (2 of 3)"), `${proofRows.join()} ${await title("proof")}`);
await page.fill(".proof-filter", "3");
await sleep(100);
const proofById = await page.$$eval(".pane-proof .pane-body .row .num", (n) => n.map((x) => x.textContent));
check("enhanced: proof filter by line number", proofById.join() === "3", proofById.join());
await page.fill(".proof-filter", "");
await page.click(".pane-proof .row.rejected .gutter");
check("enhanced: breakpoint toggle", await until(async () => !!(await page.$(".pane-proof .row.rejected .gutter.on"))));
await page.click(".pane-proof .row.rejected .text");
check("enhanced: clicking a line prefills :edit", (await page.inputValue(".plain-in")) === ":edit 3");
await command(":edit 3");
await command("@x3 rup 1 x3 >= 1 : @x1_or_x2 @x1_imp_x3 @x2_imp_x3 ;");
await command(":verify");
const fixed = await page.$$eval(".pane-proof .row:not(.preamble) .status", (s) => s.map((x) => x.textContent).join(""));
check("enhanced: after fix all checked", fixed === "✓✓✓", fixed);
await page.hover(".pane-proof .row:not(.preamble) >> nth=0");
await page.click(".pane-proof .row:not(.preamble) >> nth=0 >> .row-action");
check("enhanced: explain shows plain English first", await until(async () => (await page.textContent(".explain-plain")).includes("Suppose x3 ≥ 1 is false")),
  (await page.textContent(".explain-plain")).slice(0, 80));
check("enhanced: plain-English steps", (await page.$$(".explain-plain:not([hidden]) li")).length === 4);
await page.click(".explain-view:has-text('Checker')");
check("enhanced: Checker shows :explain's output", (await page.isVisible(".explain-body")) && (await page.textContent(".explain-body")).includes("Line 3 needed:"));
await page.click(".explain-view:has-text('Plain English')");
await page.keyboard.press("Escape");
check("enhanced: database grew", (await page.$$(".pane-database .pane-body .row")).length === 8);

// Tab completion (the TUI's completer).
const strip = () => page.$$eval(".suggest:not([hidden]) .suggestion .left", (r) => r.map((x) => x.textContent));
const typeLine = async (text) => { await page.fill(".plain-in", ""); await page.type(".plain-in", text); await sleep(150); };
await typeLine(":ve");
check("enhanced: suggestions for :ve", (await strip()).join() === ":verify", (await strip()).join());
await page.press(".plain-in", "Tab");
check("enhanced: Tab completes :verify", (await page.inputValue(".plain-in")) === ":verify ");
await typeLine(":load ");
const files = await strip();
check("enhanced: :load offers .opb files only", files.length > 0 && files.every((f) => f.endsWith(".opb")), files.join(" "));
await page.press(".plain-in", "ArrowDown");
await page.press(".plain-in", "ArrowDown");
const highlighted = await page.$eval(".suggestion.selected .left", (e) => e.textContent);
await page.press(".plain-in", "Tab");
check("enhanced: arrows + Tab insert the highlighted file", (await page.inputValue(".plain-in")) === `:load ${highlighted}`, highlighted);
await typeLine("pol @x1");
await page.press(".plain-in", "Tab");
check("enhanced: Tab completes labels to their common prefix", (await page.inputValue(".plain-in")) === "pol @x1_");
await page.fill(".plain-in", "");
await command(":debug");
await typeLine(":");
const debugNames = (await strip()).slice(0, 3).map((usage) => usage.split(" ")[0]);
check("enhanced: debug-mode vocabulary", debugNames.join() === ":step,:back,:continue", debugNames.join());
await page.fill(".plain-in", "");
const proofStatuses = () => page.$$eval(".pane-proof .row:not(.preamble) .status", (s) => s.map((x) => x.textContent).join(""));
const debugKey = async (key) => { await page.press(".plain-in", key); await sleep(50); await ready(); await sleep(100); };
const atStart = await proofStatuses();
await page.type(".plain-in", "pol");
await debugKey("Shift+ArrowUp");
const afterBack = await proofStatuses();
check("enhanced: Shift+Up runs :back, typed text kept", afterBack.split("✓").length === atStart.split("✓").length - 1 && (await page.inputValue(".plain-in")) === "pol", `${atStart} -> ${afterBack}`);
await debugKey("Shift+ArrowDown");
check("enhanced: Shift+Down runs :step", (await proofStatuses()) === atStart, await proofStatuses());
await debugKey("Escape");
check("enhanced: Esc leaves debug mode", (await page.textContent(".plain-prompt")).startsWith("pbp"), await page.textContent(".plain-prompt"));
await page.fill(".plain-in", "");
await command(":theme hi-contrast");
check("enhanced: :theme uses the REPL's palette", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(0, 0, 0)");
await command(":theme light");

await page.click('.tab:has-text("Transcript")');
const transcript = await page.textContent(".transcript");
check("enhanced: transcript has the unfolded trace", transcript.includes("line    3: @x3 rup 1 x3 >= 1") && transcript.includes("pbp> :verify"));

// Zoom buttons (the TUI's ▭ and ⛶).
const visible = (selector) => page.$eval(selector, (e) => e.offsetParent !== null);
const height = (selector) => page.$eval(selector, (e) => e.getBoundingClientRect().height);
const normalTop = await height(".enh-top");
await page.click(".pane-proof .zoom-wide");
check("enhanced: ▭ gives a pane the whole top row", (await visible(".pane-proof")) && !(await visible(".pane-formula")) && !(await visible(".pane-database")));
await page.click(".pane-proof .zoom-full");
check("enhanced: ⛶ also shrinks the bottom area", (await height(".enh-top")) > normalTop + 50, `${await height(".enh-top")} vs ${normalTop}`);
await page.click(".pane-proof .zoom-full");
check("enhanced: clicking the pressed button restores", (await visible(".pane-formula")) && Math.abs((await height(".enh-top")) - normalTop) < 2);
await page.click(".tabs .zoom-wide");
check("enhanced: bottom ▭ squeezes the panes above", (await visible(".pane-formula")) && (await height(".enh-top")) < normalTop - 50);
await page.click(".tabs .zoom-full");
check("enhanced: bottom ⛶ hides the panes above", !(await visible(".enh-top")));
await page.focus(".plain-in");
await page.press(".plain-in", "Escape");
check("enhanced: Esc restores the layout", (await visible(".pane-proof")) && Math.abs((await height(".enh-top")) - normalTop) < 2);

// Splitter: drag the first column boundary, then reload.
const columns = () => page.$eval(".enh-top", (e) => e.style.gridTemplateColumns);
const before = await columns();
const handle = await page.$(".enh-top .splitter-x");
const box = await handle.boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + 100);
await page.mouse.down();
await page.mouse.move(box.x + 200, box.y + 100, { steps: 5 });
await page.mouse.up();
const after = await columns();
check("enhanced: splitter resizes", before !== after, `${before} -> ${after}`);
await page.reload();
await ready();
check("enhanced: layout remembered", (await columns()) === after);
check("enhanced: tab remembered", (await page.getAttribute('.tab:has-text("Transcript")', "aria-selected")) === "true");

// Preserved set, from one of veripb's test instances.
const instances = join(web, "../work/veripb/tests/instances/correct/version3");
await dropFiles(["add_preserved_var.opb", "add_preserved_var.pbp"].map((n) => [n, readFileSync(join(instances, n), "utf8")]));
await until(async () => (await fileNames()).includes("add_preserved_var.pbp"));
await command(":instance add_preserved_var");
await command(":verify");
await page.click('.tab:has-text("Preserved")');
const preserved = () => page.textContent(".tab-preserved");
check("enhanced: preserved set", await until(async () => (await preserved()).includes("Current (3)")), (await preserved()).slice(0, 160));
const chips = await page.$$eval(".tab-preserved .chip.added", (c) => c.map((x) => x.textContent));
check("enhanced: preserved additions marked", chips.join() === "x5", chips.join());
await page.click('.tab:has-text("Extras")');
const extras = () => page.textContent(".tab-extras");
check("enhanced: extras summary", await until(async () => (await extras()).includes("Prompt") && (await extras()).includes("core")));
check("enhanced: extras has no preserved section", !(await extras()).includes("Preserved set"));

// Status and objective: demo 04 (clique) proves optimality.
await dropFiles([demo("clique.opb")]);
await until(async () => (await fileNames()).includes("clique.opb"));
for (const text of [":load clique.opb", "soli x1 x2 x3 x4 ~x5 ;", "@better soli x1 x2 x3 ~x4 ~x5 ;"]) await command(text);
check("enhanced: extras objective bounds", await until(async () => (await extras()).includes("Best value found so far: -3")), (await extras()).slice(0, 200));
check("enhanced: extras not yet concluded", (await page.textContent(".tab-extras .verdict")) === "NOT YET CONCLUDED");
for (const text of ["@colour_bound pol @better @no_15 + @no_34 + ;", "@contradiction rup >= 1 : @colour_bound ;"]) await command(text);
check("enhanced: extras verdict", await until(async () => (await page.textContent(".tab-extras .verdict")) === "s VERIFIED BOUNDS -3 <= obj <= -3"),
  await page.textContent(".tab-extras .verdict"));
check("enhanced: extras veripb version", (await extras()).includes("veripb3.0"));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failures ? 1 : 0);

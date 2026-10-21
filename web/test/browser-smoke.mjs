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
await page.fill(".db-filter", "@x3_imp");
await sleep(100);
const filtered = await page.$$eval(".pane-database .pane-body .row .text", (r) => r.map((x) => x.textContent));
check("enhanced: database filter", filtered.length === 2 && filtered.every((t) => t.includes("@x3_imp")), (await title("database")));
await page.fill(".db-filter", "");
await page.click(".pane-proof .row.rejected .gutter");
check("enhanced: breakpoint toggle", await until(async () => !!(await page.$(".pane-proof .row.rejected .gutter.on"))));
await page.click(".pane-proof .row.rejected .text");
check("enhanced: clicking a line prefills :edit", (await page.inputValue(".plain-in")) === ":edit 3");
await command(":edit 3");
await command("@x3 rup 1 x3 >= 1 : @x1_or_x2 @x1_imp_x3 @x2_imp_x3 ;");
await command(":verify");
const fixed = await page.$$eval(".pane-proof .row:not(.preamble) .status", (s) => s.map((x) => x.textContent).join(""));
check("enhanced: after fix all checked", fixed === "✓✓✓", fixed);
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
await command(":done");
await command(":theme hi-contrast");
check("enhanced: :theme uses the REPL's palette", (await page.evaluate(() => getComputedStyle(document.body).backgroundColor)) === "rgb(0, 0, 0)");
await command(":theme light");

await page.click('.tab:has-text("Transcript")');
const transcript = await page.textContent(".transcript");
check("enhanced: transcript has the unfolded trace", transcript.includes("line    3: @x3 rup 1 x3 >= 1") && transcript.includes("pbp> :verify"));

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
check("enhanced: preserved set", await until(async () => (await page.textContent(".tab-preserved")).includes("Current (3)")),
  (await page.textContent(".tab-preserved")).slice(0, 120));
const chips = await page.$$eval(".tab-preserved .chip.added", (c) => c.map((x) => x.textContent));
check("enhanced: preserved additions marked", chips.join() === "x5", chips.join());

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failures ? 1 : 0);

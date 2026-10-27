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
const fileNames = () => page.$$eval("#files .file-name", (as) => as.map((a) => a.textContent));
const fileRow = (name) => page.locator("#files li", { has: page.locator(".file-name", { hasText: new RegExp(`^${name.replace(/\./g, "\\.")}$`) }) });
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
await page.click("#examples");
check("classic: example files loaded", await until(async () => (await fileNames()).includes("tiny_unsat.opb")));
await fileRow("tiny_unsat.opb").locator(".file-name").dblclick();
check("classic: double-click :load", await until(async () => (await screen()).includes("from tiny_unsat.opb")));

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
await page.keyboard.press("i");
await page.keyboard.press("ControlOrMeta+a");
await page.keyboard.type("@x3 rup 1 x3 >= 1 : @x1_or_x2 @x1_imp_x3 @x2_imp_x3 ;");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(200);
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
check("enhanced: explain offers the rule's glossary entry", (await page.textContent(".explain-rule")) === "? rup");
await page.click(".explain-plain .g-link:has-text('Reverse unit propagation')");
const glossaryTitle = () => page.textContent(".glossary-entry h2");
// openGlossary closes the modal first: wait for that, so a later fill isn't
// undone by it (the Glossary may already show this entry from an earlier run).
check("enhanced: a link opens the Glossary entry", await until(async () => !(await page.$eval(".explain-modal", (d) => d.open))
  && (await page.isVisible(".tab-glossary")) && (await glossaryTitle()) === "Reverse unit propagation (RUP)"));
check("enhanced: following a link closes the modal", !(await page.$eval(".explain-modal", (d) => d.open)));
await page.fill(".glossary-search", "witness");
const glossaryItems = () => page.$$eval(".glossary-item", (items) => items.map((i) => i.textContent));
check("enhanced: glossary search", await until(async () => (await glossaryItems()).includes("Witness") && !(await glossaryItems()).includes("Slack")),
  `search ${JSON.stringify(await page.inputValue(".glossary-search"))}: ${(await glossaryItems()).join(", ")}`);
await page.click(".glossary-item:has-text('Witness')");
check("enhanced: glossary entry", (await glossaryTitle()) === "Witness" && (await page.textContent(".glossary-see")).includes("Redundance-based strengthening"));
await page.fill(".glossary-search", "");
await page.click(".glossary-item.rule:text-is('pol')");
check("enhanced: rule entries come from :help", (await page.textContent(".glossary-usage")) === "pol <reverse-polish sequence> ;");
await page.click('.tab:has-text("Output")');
check("enhanced: database grew", (await page.$$(".pane-database .pane-body .row")).length === 8);
// Constraint refs: hover shows the constraint, click jumps to it.
await page.fill(".plain-in", "");
await page.hover('.pane-proof .row:not(.preamble) >> nth=0 >> .ref[data-ref="@x1_imp_x3"]');
check("enhanced: hovering a label shows its constraint", await until(async () => (await page.textContent(".ref-tip")).includes("Constraint 2 · core")),
  await page.textContent(".ref-tip"));
check("enhanced: the proof row has no title to cover the tooltip", !(await page.$eval(".pane-proof .row:not(.preamble)", (r) => r.title)));
await page.fill(".db-filter", "zzz");
await page.click('.pane-proof .row:not(.preamble) >> nth=0 >> .ref[data-ref="@x1_imp_x3"]', { modifiers: ["ControlOrMeta"] });
check("enhanced: Ctrl/⌘+click on a proof ref jumps to its Database row", await until(async () => !!(await page.$('.pane-database .row.jumped[data-id="2"]'))));
check("enhanced: the jump clears a filter that hid it", (await page.inputValue(".db-filter")) === "");
check("enhanced: Ctrl/⌘+click doesn't prefill :edit", (await page.inputValue(".plain-in")) === "");
await page.click('.pane-proof .row:not(.preamble) >> nth=0 >> .ref[data-ref="@x1_imp_x3"]');
check("enhanced: a plain click on a proof ref still prefills :edit", (await page.inputValue(".plain-in")) === ":edit 3");
await page.click('.pane-formula .ref[data-ref="@x1_imp_x3"]');
check("enhanced: a plain click on a formula ref jumps", (await page.inputValue(".plain-in")) === ":edit 3"
  && await until(async () => !!(await page.$('.pane-database .row.jumped[data-id="2"]'))));

// Command buttons run their command as if typed.
check("buttons: enabled with a formula at pbp>", await page.$$eval(".cmd-bar .cmd", (b) => b.every((x) => !x.disabled)));
check("buttons: tooltips from the REPL's command list", (await page.getAttribute('.cmd[data-command="check"]', "title"))?.startsWith(":check"));
await page.click('.cmd[data-command="check"]');
await ready();
check("buttons: Check runs :check at the prompt", await until(async () => (await page.textContent(".plain-out")).includes("pbp> :check")));
check("buttons: and it goes into history", (await page.press(".plain-in", "ArrowUp"), await page.inputValue(".plain-in")) === ":check");
await page.fill(".plain-in", "");

// Debug: the bar swaps to Step, Back, Continue and Done.
const shownButtons = () => page.$$eval(".cmd-bar .cmd", (b) => b.filter((x) => !x.hidden).map((x) => x.textContent).join(","));
check("buttons: the pbp> set", (await shownButtons()) === "Verify,Check,Undo,Debug", await shownButtons());
const ticks = () => page.$$eval(".pane-proof .row:not(.preamble) .status", (s) => s.map((x) => x.textContent).join(""));
await page.click('.cmd[data-command="debug"]');
await ready();
check("buttons: Debug swaps to the debug set", await until(async () => (await shownButtons()) === "Step,Back,Continue,Done"), await shownButtons());
check("buttons: debug tooltips from the REPL", (await page.getAttribute('.cmd[data-command="step"]', "title"))?.startsWith(":step"));
const debugStart = await ticks();
await page.click('.cmd[data-command="back"]');
await ready();
check("buttons: Back retracts a line", await until(async () => (await ticks()).split("✓").length === debugStart.split("✓").length - 1), `${debugStart} -> ${await ticks()}`);
await page.click('.cmd[data-command="step"]');
await ready();
check("buttons: Step checks it again", await until(async () => (await ticks()) === debugStart), await ticks());
await page.click('.cmd[data-command="done"]');
await ready();
check("buttons: Done swaps back", await until(async () => (await shownButtons()) === "Verify,Check,Undo,Debug" && (await page.textContent(".plain-prompt")).startsWith("pbp")));
const echoed = await page.textContent(".plain-out");
check("buttons: the debug commands were run as typed", ["pbp> :debug", "debug> :back", "debug> :step", "debug> :done"].every((t) => echoed.includes(t)));
await page.fill(".plain-in", "");

// Clicking a row's number jumps between a line and its constraints.
const jumped = (selector) => until(async () => !!(await page.$(selector)));
await page.click('.pane-formula .row[data-ids="2"] .num');
check("jump: a formula line to its constraint", await jumped('.pane-database .row.jumped[data-id="2"]'));
// A round trip: proof line 4 to the constraint it derived, and back (the IDs
// depend on how often the proof was verified above).
await page.fill(".plain-in", "");
await page.click('.pane-proof .row[data-n="4"] .num');
check("jump: a proof line to the constraint it derived", await jumped('.pane-database .row.jumped:not([data-id="2"])'));
check("jump: the number click doesn't prefill :edit", (await page.inputValue(".plain-in")) === "");
const derivedId = await page.$eval('.pane-database .row.jumped:not([data-id="2"])', (r) => r.dataset.id);
await page.click(`.pane-database .row[data-id="${derivedId}"] .num`);
check("jump: a derived constraint back to its proof line", await jumped('.pane-proof .row.jumped[data-n="4"]'), `constraint ${derivedId}`);
await page.click('.pane-database .row[data-id="1"] .num');
check("jump: a formula constraint to its formula line", await jumped('.pane-formula .row.jumped[data-ids="1"]'));

// Vim-style editing of the Proof pane (the TUI's key set).
const proofText = (n) => page.$eval(`.pane-proof .row[data-n="${n}"] .text`, (e) => e.querySelector("input")?.value ?? e.textContent).catch(() => null);
const original5 = await proofText(5);
await page.dblclick('.pane-proof .row[data-n="5"] .num');
check("vim: double-click opens Normal mode", await until(async () => (await title("proof")).includes("-- NORMAL --")), await title("proof"));
await page.keyboard.press("x");
check("vim: x deletes the character under the cursor", await until(async () => (await proofText(5)) === original5.slice(1)), await proofText(5));
await page.keyboard.press("i");
check("vim: i enters Insert mode", await until(async () => (await title("proof")).includes("-- INSERT --")));
await page.keyboard.type("@");
await page.keyboard.press("Escape");
check("vim: Esc commits the line", await until(async () => (await proofText(5)) === original5 && (await title("proof")).includes("-- NORMAL --")), await proofText(5));
await page.keyboard.press("O");
await page.keyboard.type("rup 1 x1 1 ~x1 >= 1 ;");
await page.keyboard.press("Escape");
check("vim: O opens a line above", await until(async () => (await proofText(5)) === "rup 1 x1 1 ~x1 >= 1 ;" && (await proofText(6)) === original5),
  `${await proofText(5)} / ${await proofText(6)}`);
await page.keyboard.press("i");
await page.keyboard.press("End");
await page.keyboard.press("Enter");
await page.keyboard.type("rup >= 1 ;");
await page.keyboard.press("Escape");
check("vim: Enter in Insert splits the line", await until(async () => (await proofText(6)) === "rup >= 1 ;" && (await proofText(7)) === original5),
  `${await proofText(6)} / ${await proofText(7)}`);
await page.keyboard.press("i");
await page.keyboard.press("Home");
await page.keyboard.press("Backspace");
check("vim: Backspace at a line's start joins it to the line above", await until(async () => (await proofText(5)) === "rup 1 x1 1 ~x1 >= 1 ;rup >= 1 ;" && (await proofText(6)) === original5),
  `${await proofText(5)} / ${await proofText(6)}`);
await page.keyboard.press("Enter");
check("vim: Enter splits it again at the seam", await until(async () => (await proofText(5)) === "rup 1 x1 1 ~x1 >= 1 ;" && (await proofText(6)) === "rup >= 1 ;"),
  `${await proofText(5)} / ${await proofText(6)}`);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("End");
await page.keyboard.press("Delete");
check("vim: Delete at a line's end pulls up the line below", await until(async () => (await proofText(5)) === "rup 1 x1 1 ~x1 >= 1 ;rup >= 1 ;" && (await proofText(6)) === original5),
  `${await proofText(5)} / ${await proofText(6)}`);
await page.keyboard.press("Enter");
await page.keyboard.press("Escape");
check("vim: Enter splits it back", await until(async () => (await proofText(6)) === "rup >= 1 ;" && (await proofText(7)) === original5),
  `${await proofText(6)} / ${await proofText(7)}`);
await page.keyboard.press("d");
await page.keyboard.press("d");
check("vim: dd deletes the line", await until(async () => (await proofText(6)) === original5 && (await proofText(7)) === null), await proofText(6));
await page.keyboard.press("Escape");
check("vim: Esc in Normal mode leaves the editor", await until(async () => !(await title("proof")).includes("--")));
await command(":undo 11");
check("vim: each commit is one :undo action", await until(async () => (await proofText(5)) === original5 && (await proofText(6)) === null),
  `${await proofText(5)} / ${await proofText(6)}`);
await command(":edit 4");
check("vim: :edit opens Normal mode on the line", await until(async () => (await title("proof")).includes("-- NORMAL --")
  && !!(await page.$('.pane-proof .row.vim-line[data-n="4"]'))));
await page.keyboard.press(":");
check("vim: : goes to the prompt", (await page.inputValue(".plain-in")) === ":" && !(await title("proof")).includes("--"));
await page.fill(".plain-in", "");

// Insert mode holds edits until Esc: moving off a line commits nothing, and
// a line edited back to what it was stays checked.
const proofStatus = () => page.$$eval(".pane-proof .row:not(.preamble) .status", (s) => s.map((x) => x.textContent).join(""));
const original3 = await proofText(3);
check("held: all checked first", await until(async () => (await proofStatus()) === "✓✓✓"), await proofStatus());
await command(":edit 3");
await page.keyboard.press("i");
await page.keyboard.type("Z");
await page.keyboard.press("ArrowDown");
check("held: moving off an edited line holds it, uncommitted", await until(async () => !!(await page.$('.pane-proof .row.held[data-n="3"]'))
  && (await proofText(3)) === `Z${original3}` && (await proofStatus()) === "✓✓✓"), `${await proofText(3)} ${await proofStatus()}`);
await page.keyboard.press("ArrowUp");
await page.keyboard.press("Home");
await page.keyboard.press("Delete");
await page.keyboard.press("Escape");
await sleep(300);
check("held: a line edited back stays checked", await until(async () => (await proofStatus()) === "✓✓✓" && (await proofText(3)) === original3),
  `${await proofText(3)} ${await proofStatus()}`);
await page.keyboard.press("Escape");

// Editing a comment keeps the lines after it checked.
await command(":insert 6");
await page.keyboard.type("% a note");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(200);
await command(":verify");
check("comment: verified with the comment", await until(async () => (await proofStatus()) === "✓✓✓✓"), await proofStatus());
await command(":edit 4");
await page.keyboard.press("O");
await page.keyboard.type("% another note");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
await sleep(200);
await command(":verify");
check("comment: two comments, all checked", await until(async () => (await proofStatus()) === "✓✓✓✓✓"), await proofStatus());
await command(":edit 4");
await page.keyboard.press("i");
await page.keyboard.press("End");
await page.keyboard.type(", reworded");
await page.keyboard.press("Escape");
await page.keyboard.press("Escape");
check("comment: editing a comment keeps every line checked", await until(async () => (await proofText(4)) === "% another note, reworded" && (await proofStatus()) === "✓✓✓✓✓"),
  `${await proofText(4)} ${await proofStatus()}`);
await command(":edit 7");
await page.keyboard.press("d");
await page.keyboard.press("d");
await command(":edit 4");
await page.keyboard.press("d");
await page.keyboard.press("d");
await page.keyboard.press("Escape");
await sleep(200);
await command(":verify");
check("comment: the comments removed again", await until(async () => (await proofStatus()) === "✓✓✓" && (await proofText(4)) !== null && (await proofText(6)) === null),
  await proofStatus());

// Links: a curve per formula line and per proof line to its Database row.
await page.selectOption(".links-toggle select", "all");
check("enhanced: links draw a curve per line", await until(async () => (await page.$$(".links-layer path")).length === 8), String((await page.$$(".links-layer path")).length));
check("enhanced: links widen the gutters", (await page.$eval(".enh-top", (e) => e.style.gridTemplateColumns)).includes("56px"));
await page.selectOption(".links-toggle select", "hover");
await page.mouse.move(1, 1);
const shownLinks = () => page.$$eval(".links-layer path", (ps) => ps.filter((p) => getComputedStyle(p).display !== "none").length);
check("enhanced: hovered-row links hide the rest", await until(async () => (await shownLinks()) === 0), String(await shownLinks()));
await page.hover('.pane-proof .row[data-n="3"] .num');
check("enhanced: hovered-row links show that row's curve", await until(async () => (await shownLinks()) === 1), String(await shownLinks()));
await page.selectOption(".links-toggle select", "off");
check("enhanced: links off removes them", !(await page.$(".links-layer")) && !(await page.$eval(".enh-top", (e) => e.style.gridTemplateColumns)).includes("56px"));

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
// The transcript is a virtual list: find lines with its filter.
const transcriptHas = async (text) => {
  await page.fill(".transcript-filter", text);
  return until(async () => (await page.$$eval(".transcript .row.line", (r) => r.map((x) => x.textContent))).some((row) => row.includes(text)));
};
check("enhanced: transcript has the unfolded trace", (await transcriptHas("line    3: @x3 rup 1 x3 >= 1")) && (await transcriptHas("pbp> :verify")));
await page.fill(".transcript-filter", "");
await page.fill(".transcript-filter", "pbp> :verify");
check("enhanced: the transcript filter", await until(async () => {
  const rows = await page.$$eval(".transcript .row.line", (r) => r.map((x) => x.textContent));
  return rows.length >= 1 && rows.every((row) => row.includes("pbp> :verify"));
}));
await page.fill(".transcript-filter", "");

// Files panel: badges, double-click to :load / :source.
check("files: F and P badges", (await fileRow("tiny_unsat.opb").locator(".file-kind").textContent()) === "F"
  && (await fileRow("tiny_unsat.pbp").locator(".file-kind").textContent()) === "P");
await fileRow("tiny_unsat.opb").locator(".file-name").dblclick();
await sleep(50);
await ready();
check("files: double-click an .opb runs :load", await until(async () => (await title("formula")).startsWith("Formula: tiny_unsat.opb")), await title("formula"));
await fileRow("tiny_unsat.pbp").locator(".file-name").dblclick();
await sleep(50);
await ready();
check("files: double-click a .pbp runs :source", await until(async () => (await page.textContent(".plain-out")).includes("pbp> :source tiny_unsat.pbp")));
check("files: the command is in history", (await page.press(".plain-in", "ArrowUp"), await page.inputValue(".plain-in")) === ":source tiny_unsat.pbp");
await page.fill(".plain-in", "");

// Leaving the page: Backspace outside a text field, and the leave guard.
const backspacePrevented = () => page.evaluate(() => {
  const event = new KeyboardEvent("keydown", { key: "Backspace", bubbles: true, cancelable: true });
  document.body.dispatchEvent(event);
  return event.defaultPrevented;
});
check("page: Backspace outside a text field does nothing", await backspacePrevented());
await page.fill(".plain-in", "ab");
await page.press(".plain-in", "Backspace");
check("page: Backspace still edits the prompt", (await page.inputValue(".plain-in")) === "a");
await page.fill(".plain-in", "");
check("page: asks before leaving while there are files", await page.evaluate(() => {
  const event = new Event("beforeunload", { cancelable: true });
  dispatchEvent(event);
  return event.defaultPrevented;
}));

// The explain button sits at the pane's visible right edge on every row.
await page.hover(".pane-proof .row:not(.preamble) >> nth=0");
const explainGap = await page.evaluate(() => {
  const body = document.querySelector(".pane-proof .pane-body").getBoundingClientRect();
  const button = document.querySelector(".pane-proof .row:not(.preamble) .row-action").getBoundingClientRect();
  return Math.round(body.right - button.right);
});
check("enhanced: explain button at the pane's right edge", explainGap >= 0 && explainGap < 20, `${explainGap}px from the edge`);

// Stats: a pane's title opens its statistics.
await page.click(".pane-proof .pane-title-text");
await page.waitForSelector(".stats-modal[open] .stat-tiles");
const legend = await page.$$eval(".stats-modal .donut-legend li .legend-name", (names) => names.map((n) => n.textContent));
check("stats: the Proof title opens a donut of its rules", legend.length > 0 && (await page.$$(".stats-modal .donut path, .stats-modal .donut circle")).length === legend.length, legend.join(","));
await page.hover(".stats-modal .donut-legend li >> nth=0");
check("stats: hovering a rule shows its share in the middle", (await page.textContent(".stats-modal .donut-label")) === legend[0]);
await page.keyboard.press("Escape");
check("stats: Esc closes it", !(await page.$(".stats-modal[open]")));
await page.click(".pane-database .pane-title-text");
await page.waitForSelector(".stats-modal[open] .parts-bar");
check("stats: the Database's core and derived", (await page.$$eval(".stats-modal .parts-legend >> nth=0", (l) => l[0].textContent)).includes("core"));
await page.click(".stats-modal .explain-tools button");
await page.focus(".pane-formula .pane-title-text");
await page.keyboard.press("Enter");
await page.waitForSelector(".stats-modal[open] .hbars");
check("stats: the Formula's, from the keyboard", (await page.textContent(".stats-modal h2")) === "Formula statistics");
await page.keyboard.press("Escape");

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
check("enhanced: no proof-file line for conclusion NONE", await until(async () => (await extras()).includes("Status") && !(await extras()).includes("Proof file")));

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
// The proof file's own conclusion, beside what veripb accepted.
await dropFiles([demo("two-of-three.opb"), demo("two-of-three.pbp")]);
await until(async () => (await fileNames()).includes("two-of-three.pbp"));
await command(":instance two-of-three");
await command(":verify");
// This demo's proof claims UNSAT but derives no contradiction (demo 02 finds
// its wrong pol step), so the claim shows as not verified.
check("enhanced: extras shows the proof file's conclusion", await until(async () => (await extras()).includes("Proof fileconcludes UNSAT (not verified yet)")),
  (await extras()).slice(0, 240));

check("no page errors", errors.length === 0, errors.join(" | "));
await browser.close();
process.exit(failures ? 1 : 0);

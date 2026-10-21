#!/usr/bin/env python3
"""Replays veripb-repl's demo screenshot scripts (demos/tools/*.json)
against the native TUI in a pseudo-terminal and against the web build
(web/test/tui-bridge.mjs), and compares the screen text at every "snap"
step. Screens are rendered by the scripts' own emulator
(demos/tools/tuishot.py, `Screen`).

Native veripb and veripb-repl are built from the unpatched submodules.
Temp-file paths are normalised before comparing (`normalise`).

Usage: web/test/compare-tui.py [script.json ...]   (default: all four)
Exit status 1 if any screen differs.
"""

import base64, codecs, difflib, fcntl, glob, json, os, pty, re, shutil, struct
import subprocess, sys, tempfile, termios, time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
REPL = os.path.join(ROOT, "upstream", "veripb-repl")
sys.path.insert(0, os.path.join(REPL, "demos", "tools"))
sys.dont_write_bytecode = True  # no __pycache__ inside the submodule
import tuishot  # noqa: E402

NATIVE_TARGET = os.environ.get("NATIVE_TARGET_DIR", os.path.expanduser("~/.cache/veripb-native"))
TEMP_NAME = re.compile(r"/\.?tmp/\.tmp[A-Za-z0-9]{6}")


def normalise(screen):
    """Temp-file paths replaced (native /tmp, web /.tmp); on those lines the
    padding before a pane border is collapsed, since the paths differ in
    length."""
    lines = []
    for line in screen.split("\n"):
        if TEMP_NAME.search(line):
            line = re.sub(r" +(?=[│┃])", " ", TEMP_NAME.sub("TMP/.tmpXXXXXX", line))
        lines.append(line)
    return "\n".join(lines)


def build_native():
    env = dict(os.environ, CARGO_TARGET_DIR=NATIVE_TARGET)
    for crate, extra in (("veripb", ["--bin", "veripb"]), ("veripb-repl", [])):
        subprocess.run(["cargo", "build", "-q", "--locked", "--release", *extra],
                       cwd=os.path.join(ROOT, "upstream", crate), env=env, check=True)
    return os.path.join(NATIVE_TARGET, "release", "veripb-repl"), os.path.join(NATIVE_TARGET, "release", "veripb")


def click_bytes(screen, marker, target):
    """The SGR mouse press and release on `target`, searched for after `marker`."""
    rows = screen.text().split("\n")
    y = next(i for i, row in enumerate(rows) if marker in row)
    x = rows[y].index(target, rows[y].index(marker))
    return "".join(f"\x1b[<0;{x + 1};{y + 1}{final}" for final in "Mm")


def run_native(spec, repl_bin, veripb_bin):
    cols, rows = spec.get("cols", 120), spec.get("rows", 36)
    workdir = tempfile.mkdtemp(prefix="compare-tui-")
    for path in spec.get("copy", []):
        shutil.copytree(os.path.join(REPL, path), os.path.join(workdir, path))
    pid, fd = pty.fork()
    if pid == 0:
        os.chdir(workdir)
        env = dict(os.environ, TERM="xterm-256color", COLORTERM="truecolor", VERIPB_REPL_VERIPB_BIN=veripb_bin)
        os.execvpe(repl_bin, [repl_bin] + spec["cmd"][1:], env)
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))
    screen = tuishot.Screen(cols, rows)
    snaps = []
    tuishot.pump(fd, screen, 1.5)
    for step in spec["steps"]:
        if "keys" in step:
            for ch in step["keys"]:
                os.write(fd, ch.encode())
                time.sleep(step.get("delay", 0.01))
            tuishot.pump(fd, screen, step.get("settle", 0.8))
        elif "click" in step:
            os.write(fd, click_bytes(screen, *step["click"]).encode())
            tuishot.pump(fd, screen, step.get("settle", 0.8))
        elif "wait" in step:
            tuishot.pump(fd, screen, step["wait"])
        elif "snap" in step:
            snaps.append((os.path.basename(step["snap"]), screen.text()))
    os.write(fd, b"\x1b:quit\r")
    tuishot.pump(fd, screen, 0.5)
    shutil.rmtree(workdir, ignore_errors=True)
    return snaps


class Bridge:
    """tui-bridge.mjs as a pseudo-terminal."""

    def __init__(self, cols, rows, files_dir, args):
        self.proc = subprocess.Popen(
            ["node", "--no-warnings", os.path.join(ROOT, "web", "test", "tui-bridge.mjs"),
             str(cols), str(rows), files_dir, *args],
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, text=True)
        self.screen = tuishot.Screen(cols, rows)
        self.decoder = codecs.getincrementaldecoder("utf-8")()

    def send(self, message):
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def idle(self):
        self.send({"idle": True})
        while True:
            reply = json.loads(self.proc.stdout.readline())
            if "tty" in reply:
                self.screen.feed(self.decoder.decode(base64.b64decode(reply["tty"])))
            elif "idle" in reply:
                return
            else:
                raise RuntimeError(f"bridge: {reply}")

    def keys(self, text):
        # One write per step: the scripts give a lone Esc a step of its own,
        # and an escape sequence (a click) must arrive whole.
        self.send({"keys": text})
        self.idle()

    def close(self):
        self.proc.stdin.close()
        self.proc.wait(timeout=10)


def run_web(spec):
    cols, rows = spec.get("cols", 120), spec.get("rows", 36)
    files_dir = tempfile.mkdtemp(prefix="compare-tui-web-")
    for path in spec.get("copy", []):
        shutil.copytree(os.path.join(REPL, path), os.path.join(files_dir, path))
    bridge = Bridge(cols, rows, files_dir, spec["cmd"][1:])
    snaps = []
    bridge.idle()
    for step in spec["steps"]:
        if "keys" in step:
            bridge.keys(step["keys"])
        elif "click" in step:
            bridge.keys(click_bytes(bridge.screen, *step["click"]))
        elif "snap" in step:
            snaps.append((os.path.basename(step["snap"]), bridge.screen.text()))
    bridge.close()
    shutil.rmtree(files_dir, ignore_errors=True)
    return snaps


def main():
    scripts = sys.argv[1:] or sorted(glob.glob(os.path.join(REPL, "demos", "tools", "0*.json")))
    repl_bin, veripb_bin = build_native()
    failed = False
    for path in scripts:
        spec = json.load(open(path))
        native, web = run_native(spec, repl_bin, veripb_bin), run_web(spec)
        name = os.path.basename(path)
        for (snap, a), (_, b) in zip(native, web):
            a, b = normalise(a), normalise(b)
            if a == b:
                print(f"same   {name} {snap}")
            else:
                failed = True
                print(f"DIFFER {name} {snap}")
                sys.stdout.writelines(difflib.unified_diff(
                    a.splitlines(True), b.splitlines(True), "native", "web", n=1))
        if len(native) != len(web):
            failed = True
            print(f"DIFFER {name}: {len(native)} native snaps, {len(web)} web snaps")
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()

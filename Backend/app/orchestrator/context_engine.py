#!/usr/bin/env python3
"""PatchTree context engine.

Picks the few hundred lines of a repository that matter for a failing test, inside a
token budget, using only the Python standard library (so it can be copied into any
sandbox container and run next to the cloned repo with one command).

Usage (inside the container):
    python3 context_engine.py --repo /workspace/repo --budget 4000 \
        --hint-file bug.txt < failure_output.txt          # prints JSON

    python3 context_engine.py --repo /workspace/repo --budget 2500 \
        --symbols "src/parser.py::Parser._parse_token" --symbols build_payload

Pipeline in short:
    1. parse_frames()      traceback -> ordered list of (file, line, function)
    2. Engine.run()        turns frames into ranked "candidates" (code blocks)
    3. pack()              fits candidates into the token budget, richest first
    4. render              numbered lines + a short "why this is here" label
"""
from __future__ import annotations

import argparse
import ast
import builtins
import json
import os
import re
import subprocess
import sys
import time
import warnings
from dataclasses import dataclass, field
from typing import Dict, List, Optional, Tuple

warnings.simplefilter("ignore")

CHARS_PER_TOKEN = 3.2          # conservative for code; over-estimates tokens slightly
DEFAULT_BUDGET = 4000
DEFAULT_DEADLINE_S = 2.5
MAX_FILE_BYTES = 1_500_000
MAX_LINE_CHARS = 200
SKIP_DIRS = {".git", "node_modules", "venv", ".venv", "env", "site-packages", "__pycache__",
             "build", "dist", ".tox", ".eggs", ".mypy_cache", ".pytest_cache"}
ASSET_EXT = r"(?:c|h|cc|cpp|hpp|pyx|pxd|pxi|sql|json|ya?ml|toml|cfg|ini|html|jinja2?|j2|xml)"
BUILTIN_NAMES = set(dir(builtins))
COMMON_ATTRS = {
    "get", "items", "keys", "values", "append", "extend", "join", "split", "format", "strip",
    "update", "pop", "add", "read", "write", "close", "open", "encode", "decode", "copy",
    "sort", "remove", "insert", "index", "count", "startswith", "endswith", "lower", "upper",
    "replace", "find", "run", "call", "info", "debug", "warning", "error", "exception",
    "fetch", "load", "dump", "loads", "dumps", "match", "search", "sub", "group", "send",
    "start", "stop", "clear", "setdefault", "discard", "lstrip", "rstrip", "seek", "flush",
}
STOP_IDENTS = {"this_is", "should_be", "does_not", "can_not", "test_case", "stack_trace"}


def est_tokens(text: str) -> int:
    return int(len(text) / CHARS_PER_TOKEN) + 1


class Deadline:
    def __init__(self, seconds: float):
        self.end = time.monotonic() + seconds

    def left(self) -> float:
        return max(0.0, self.end - time.monotonic())

    def expired(self) -> bool:
        return time.monotonic() >= self.end


# --------------------------------------------------------------------------------------
# 1. Parsing the failure output
# --------------------------------------------------------------------------------------
_NATIVE = re.compile(r'File "(?P<path>[^"<][^"]*)", line (?P<line>\d+)(?:, in (?P<func>\S+))?')
_PYTEST = re.compile(
    r"^(?P<path>[^\s:\"'][^:\n]*?\.(?:py|pyx|pxd)):(?P<line>\d+):"
    r"(?:[ ]in (?P<func>[\w<>.]+)|[ ](?P<exc>[A-Za-z_][\w.]*))?[ \t]*$", re.M)
_ASSET_RE = re.compile(r"([A-Za-z0-9_./\\-]+\.%s)(?::(\d+))?" % ASSET_EXT)
_BACKTICK = re.compile(r"`([A-Za-z_][\w.]*)(?:\(\))?`")
_CALLISH = re.compile(r"\b([A-Za-z_]\w{3,})\(")
_SNAKE_CAMEL = re.compile(r"\b([a-z]+(?:_[a-z0-9]+)+|[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+)\b")


@dataclass
class Frame:
    path: str
    line: int
    func: str = ""
    rel: Optional[str] = None
    is_test: bool = False


def parse_frames(text: str) -> List[Frame]:
    """Both plain Python tracebacks and pytest's own format. Order: outermost -> innermost."""
    hits = []
    for m in _NATIVE.finditer(text):
        hits.append((m.start(), m.group("path"), int(m.group("line")), m.group("func") or ""))
    for m in _PYTEST.finditer(text):
        hits.append((m.start(), m.group("path"), int(m.group("line")), m.group("func") or ""))
    hits.sort(key=lambda h: h[0])
    seen, frames = set(), []
    for _, path, line, func in hits:
        if (path, line) in seen:
            continue
        seen.add((path, line))
        frames.append(Frame(path, line, func))
    return frames


def exception_summary(text: str) -> str:
    e_lines = [l[1:].strip() for l in text.splitlines() if l.startswith("E ")]
    for l in reversed(e_lines):
        if re.match(r"^[\w.]*(Error|Exception|Exit|Warning)\b", l):
            return l[:200]
    if e_lines:
        return e_lines[-1][:200]
    for l in reversed(text.splitlines()):
        if re.match(r"^[\w.]*(Error|Exception)\b", l.strip()):
            return l.strip()[:200]
    return ""


def extract_identifiers(text: str, limit: int = 6) -> List[str]:
    found: List[str] = []

    def add(name: str):
        name = name.split(".")[-1]
        if (len(name) >= 4 and name not in BUILTIN_NAMES and name not in COMMON_ATTRS
                and name not in STOP_IDENTS and name not in found):
            found.append(name)

    for m in _BACKTICK.finditer(text):
        add(m.group(1))
    for m in _CALLISH.finditer(text):
        add(m.group(1))
    for m in _SNAKE_CAMEL.finditer(text):
        add(m.group(1))
    return found[:limit]


# --------------------------------------------------------------------------------------
# 2. File index (AST scopes) -- built lazily, only for files we actually need
# --------------------------------------------------------------------------------------
def node_end(node: ast.AST) -> int:
    end = getattr(node, "end_lineno", None)
    if end:
        return end
    m = getattr(node, "lineno", 1)
    for n in ast.walk(node):
        m = max(m, getattr(n, "end_lineno", None) or getattr(n, "lineno", 0))
    return m


@dataclass
class Scope:
    qual: str
    kind: str                  # "function" | "class"
    name: str
    start: int                 # first line incl. decorators
    def_line: int
    end: int
    sig_end: int
    doc_end: int               # 0 when there is no docstring
    parent: Optional["Scope"]
    node: ast.AST
    decorators: List[ast.expr]
    bases: List[ast.expr]


@dataclass
class Variant:
    level: str
    text: str
    tokens: int
    start: int
    end: int
    contiguous: bool = False


@dataclass
class Candidate:
    key: str
    path: str
    reason: str
    score: float
    variants: List[Variant]


def merge_segments(segs: List[Tuple[int, int]]) -> List[Tuple[int, int]]:
    out: List[List[int]] = []
    for s, e in sorted(x for x in segs if x[1] >= x[0]):
        if out and s <= out[-1][1] + 1:
            out[-1][1] = max(out[-1][1], e)
        else:
            out.append([s, e])
    return [(a, b) for a, b in out]


class FileIndex:
    def __init__(self, repo: str, rel: str):
        self.rel = rel
        self.lines: List[str] = []
        self.tree: Optional[ast.AST] = None
        self.parse_error: Optional[str] = None
        self.scopes: List[Scope] = []
        self.by_qual: Dict[str, Scope] = {}
        self.by_name: Dict[str, List[Scope]] = {}
        self.imports: Dict[str, Tuple[str, Optional[str], int]] = {}
        full = os.path.join(repo, rel)
        try:
            if os.path.getsize(full) > MAX_FILE_BYTES:
                raise ValueError("file too large")
            with open(full, "rb") as fh:
                raw = fh.read()
            if b"\0" in raw[:2048]:
                raise ValueError("binary file")
            text = raw.decode("utf-8", "replace")
        except (OSError, ValueError) as exc:
            self.parse_error = str(exc)
            return
        self.lines = text.splitlines()
        if rel.endswith(".py"):
            try:
                self.tree = ast.parse(text)
                self._collect(self.tree, None, "")
                for n in ast.walk(self.tree):
                    if isinstance(n, ast.Import):
                        for a in n.names:
                            local = a.asname or a.name.split(".")[0]
                            self.imports[local] = (a.name if a.asname else a.name.split(".")[0], None, 0)
                    elif isinstance(n, ast.ImportFrom):
                        for a in n.names:
                            self.imports[a.asname or a.name] = (n.module or "", a.name, n.level or 0)
            except (SyntaxError, ValueError, RecursionError, MemoryError) as exc:
                self.tree, self.scopes = None, []
                self.by_qual, self.by_name, self.imports = {}, {}, {}
                self.parse_error = f"{type(exc).__name__}: {exc}"

    @property
    def ok(self) -> bool:
        return bool(self.lines)

    def _collect(self, node: ast.AST, parent: Optional[Scope], prefix: str) -> None:
        for child in ast.iter_child_nodes(node):
            if isinstance(child, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                kind = "class" if isinstance(child, ast.ClassDef) else "function"
                decs = list(child.decorator_list)
                start = min([child.lineno] + [getattr(d, "lineno", child.lineno) for d in decs])
                first = child.body[0]
                sig_end = first.lineno - 1 if first.lineno > child.lineno else child.lineno
                doc_end = node_end(first) if ast.get_docstring(child, clean=False) is not None else 0
                scope = Scope(f"{prefix}{child.name}", kind, child.name, start, child.lineno,
                              node_end(child), max(sig_end, child.lineno), doc_end, parent, child,
                              decs, list(getattr(child, "bases", [])))
                self.scopes.append(scope)
                self.by_qual[scope.qual] = scope
                self.by_name.setdefault(child.name, []).append(scope)
                self._collect(child, scope, scope.qual + ".")
            elif not isinstance(child, ast.expr):
                self._collect(child, parent, prefix)

    def enclosing(self, line: int) -> Optional[Scope]:
        best = None
        for s in self.scopes:
            if s.start <= line <= s.end:
                if best is None or (s.end - s.start, s.kind != "function") < (best.end - best.start, best.kind != "function"):
                    best = s
        return best

    # ---- rendering -------------------------------------------------------------
    def render(self, segs: List[Tuple[int, int]]) -> str:
        out, prev_end = [], None
        for s, e in merge_segments(segs):
            s, e = max(1, s), min(len(self.lines), e)
            if e < s:
                continue
            if prev_end is not None and s > prev_end + 1:
                out.append(f"      ... [{s - prev_end - 1} lines skipped] ...")
            for n in range(s, e + 1):
                ln = self.lines[n - 1]
                if len(ln) > MAX_LINE_CHARS:
                    ln = ln[:MAX_LINE_CHARS] + "..."
                out.append(f"{n:>5} | {ln}")
            prev_end = e
        return "\n".join(out)

    def _make_variants(self, options: List[Tuple[str, List[Tuple[int, int]], List[Tuple[int, int]]]]) -> List[Variant]:
        out, seen = [], set()
        for level, prefix, body in options:
            text = self.render(prefix + body)
            if not text or text in seen:
                continue
            seen.add(text)
            flat = merge_segments(body or prefix)
            out.append(Variant(level, text, est_tokens(text), max(1, flat[0][0]),
                               min(len(self.lines), flat[-1][1]), len(flat) == 1))
        out.sort(key=lambda v: -v.tokens)
        return out

    def scope_variants(self, scope: Scope, focus: Optional[int] = None, full_cap: int = 120) -> List[Variant]:
        p = scope.parent
        pre = [(p.start, p.sig_end)] if p else []
        header = [(scope.start, max(scope.sig_end, scope.doc_end))]
        size = scope.end - scope.start + 1
        opts = []
        if scope.kind == "class" and size > full_cap:
            return self._class_outline(scope, pre)
        if size <= full_cap:
            opts.append(("full", pre, [(scope.start, scope.end)]))
        elif not focus:
            opts.append(("head", pre, header + [(scope.sig_end + 1, scope.sig_end + 25)]))
        if focus:
            for level, w in (("wide", 30), ("narrow", 10)):
                opts.append((level, pre, header + [(max(scope.start, focus - w), min(scope.end, focus + w))]))
        sig = [(scope.start, scope.sig_end)]
        if scope.doc_end:
            sig.append((scope.sig_end + 1, min(scope.doc_end, scope.sig_end + 3)))
        opts.append(("signature", pre, sig))
        return self._make_variants(opts)

    def _class_outline(self, scope: Scope, pre) -> List[Variant]:
        names = [x.name for x in self.scopes if x.parent is scope and x.kind == "function"][:15]
        text = self.render(pre + [(scope.start, scope.sig_end)])
        if names:
            text += "\n      # methods: " + ", ".join(names)
        return [Variant("outline", text, est_tokens(text), scope.start, scope.sig_end)]

    def window_variants(self, focus: Optional[int]) -> List[Variant]:
        n = len(self.lines)
        if not focus:
            return self._make_variants([("head", [], [(1, min(n, 40))]), ("head-short", [], [(1, min(n, 15))])])
        head = [(1, min(n, 20))] if self.rel.endswith(".py") else []
        return self._make_variants([
            ("wide", [], head + [(focus - 25, focus + 25)]),
            ("narrow", [], [(focus - 8, focus + 8)]),
            ("tight", [], [(focus - 3, focus + 3)]),
        ])

    def skeleton_variants(self) -> List[Variant]:
        if not self.tree:
            return []
        body = self.tree.body  # type: ignore[attr-defined]
        imps, consts = [], []
        for st in body:
            if isinstance(st, (ast.Import, ast.ImportFrom)):
                imps.append((st.lineno, node_end(st)))
            elif isinstance(st, ast.Assign) and len(consts) < 10:
                names = [t.id for t in st.targets if isinstance(t, ast.Name)]
                if names and all(nm.isupper() for nm in names):
                    consts.append((st.lineno, node_end(st)))
        names = [s.name + ("()" if s.kind == "class" else "") for s in self.scopes if s.parent is None][:25]
        outline = "      # top-level names: " + ", ".join(names) if names else ""
        opts = []
        for level, segs in (("skeleton", imps[:25] + consts), ("imports", imps[:15])):
            text = self.render(segs)
            if text:
                text = text + ("\n" + outline if outline and level == "skeleton" else "")
                opts.append(Variant(level, text, est_tokens(text), 1, segs[-1][1]))
        opts.sort(key=lambda v: -v.tokens)
        return opts


# --------------------------------------------------------------------------------------
# 3. Resolver: where is this name defined? (no LSP, no installs)
# --------------------------------------------------------------------------------------
def dotted(expr: ast.AST) -> str:
    if isinstance(expr, ast.Name):
        return expr.id
    if isinstance(expr, ast.Attribute):
        head = dotted(expr.value)
        return f"{head}.{expr.attr}" if head else expr.attr
    if isinstance(expr, ast.Subscript):
        return dotted(expr.value)
    if isinstance(expr, ast.Call):
        return dotted(expr.func)
    return ""


def enclosing_class(scope: Optional[Scope]) -> Optional[Scope]:
    while scope is not None:
        if scope.kind == "class":
            return scope
        scope = scope.parent
    return None


class Resolver:
    def __init__(self, repo: str, deadline: Deadline, use_git: bool = True):
        self.repo = os.path.abspath(repo)
        self.deadline = deadline
        self.use_git = use_git
        self._idx: Dict[str, Optional[FileIndex]] = {}
        self._files: Optional[List[str]] = None
        self._basenames: Optional[Dict[str, List[str]]] = None
        self._grep: Dict[str, List[Tuple[str, int]]] = {}

    # ---- files -------------------------------------------------------------------
    def index(self, rel: Optional[str]) -> Optional[FileIndex]:
        if not rel:
            return None
        if rel not in self._idx:
            fi = FileIndex(self.repo, rel)
            self._idx[rel] = fi if fi.ok else None
        return self._idx[rel]

    def files(self) -> List[str]:
        if self._files is None:
            out: List[str] = []
            if self.use_git:
                try:
                    r = subprocess.run(["git", "ls-files"], cwd=self.repo, capture_output=True, text=True,
                                       timeout=max(0.2, min(1.0, self.deadline.left())))
                    if r.returncode == 0:
                        out = [l for l in r.stdout.splitlines() if l]
                except (OSError, subprocess.SubprocessError):
                    out = []
            if not out:
                for root, dirs, names in os.walk(self.repo):
                    dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
                    for nm in names:
                        out.append(os.path.relpath(os.path.join(root, nm), self.repo).replace(os.sep, "/"))
                    if self.deadline.expired():
                        break
            self._files = out
            self._basenames = {}
            for f in out:
                self._basenames.setdefault(os.path.basename(f), []).append(f)
        return self._files

    def by_basename(self, name: str) -> List[str]:
        self.files()
        return (self._basenames or {}).get(name, [])

    def to_rel(self, p: str) -> Optional[str]:
        p = p.replace("\\", "/")
        if "site-packages" in p or "dist-packages" in p:
            return None
        if os.path.isabs(p):
            root = self.repo.replace("\\", "/").rstrip("/") + "/"
            if p.startswith(root):
                rel = p[len(root):]
                return rel if os.path.isfile(os.path.join(self.repo, rel)) else None
            if p.startswith(("/usr/", "/lib/", "/opt/")):
                return None
        parts = [x for x in p.split("/") if x not in ("", ".")]
        for i in range(len(parts)):
            cand = "/".join(parts[i:])
            if os.path.isfile(os.path.join(self.repo, cand)):
                return cand
        return None

    # ---- modules / imports --------------------------------------------------------
    def module_to_rel(self, module: str, level: int, from_rel: str) -> Optional[str]:
        parts = [x for x in module.split(".") if x]
        roots: List[str] = []
        if level > 0:
            base = os.path.dirname(from_rel)
            for _ in range(level - 1):
                base = os.path.dirname(base)
            roots.append(base)
        else:
            roots += ["", "src", "lib"]
            d = os.path.dirname(from_rel)
            while d and os.path.isfile(os.path.join(self.repo, d, "__init__.py")):
                d = os.path.dirname(d)
            roots.append(d)
        for root in roots:
            for cand in ("/".join([root] + parts).strip("/") + ".py",
                         "/".join([root] + parts + ["__init__"]).strip("/") + ".py"):
                if parts or cand.endswith("__init__.py"):
                    if os.path.isfile(os.path.join(self.repo, cand)):
                        return cand
        return None

    def lookup_top(self, fi: FileIndex, name: str) -> Optional[Scope]:
        cands = fi.by_name.get(name, [])
        mod = [s for s in cands if s.parent is None]
        return (mod or cands or [None])[0]

    def import_symbol(self, local: str, fi: FileIndex, depth: int = 0) -> Optional[Tuple[FileIndex, Scope]]:
        imp = fi.imports.get(local)
        if not imp or imp[1] is None:
            return None
        module, attr, level = imp
        rel = self.module_to_rel(module, level, fi.rel)
        target = self.index(rel)
        if target:
            s = self.lookup_top(target, attr)
            if s:
                return target, s
            if depth < 3 and attr in target.imports:
                return self.import_symbol(attr, target, depth + 1)
        return None

    def module_for_local(self, local: str, fi: FileIndex) -> Optional[str]:
        imp = fi.imports.get(local)
        if not imp:
            return None
        module, attr, level = imp
        if attr is None:
            return self.module_to_rel(module, level, fi.rel)
        return self.module_to_rel(f"{module}.{attr}" if module else attr, level, fi.rel)

    def resolve_class(self, name: str, fi: FileIndex) -> Optional[Tuple[FileIndex, Scope]]:
        if not name:
            return None
        if "." in name:
            head, tail = name.split(".", 1)
            target = self.index(self.module_for_local(head, fi))
            if target:
                s = self.lookup_top(target, tail.split(".")[-1])
                if s and s.kind == "class":
                    return target, s
            return None
        s = self.lookup_top(fi, name)
        if s and s.kind == "class":
            return fi, s
        r = self.import_symbol(name, fi)
        return r if r and r[1].kind == "class" else None

    def class_lookup(self, fi: FileIndex, cls: Scope, name: str, skip_self: bool = False,
                     depth: int = 0, seen: Optional[set] = None) -> Optional[Tuple[FileIndex, Scope]]:
        seen = seen if seen is not None else set()
        key = (fi.rel, cls.qual)
        if key in seen or depth > 4:
            return None
        seen.add(key)
        if not skip_self:
            m = fi.by_qual.get(f"{cls.qual}.{name}")
            if m:
                return fi, m
        for b in cls.bases:
            target = self.resolve_class(dotted(b), fi)
            if target:
                r = self.class_lookup(target[0], target[1], name, False, depth + 1, seen)
                if r:
                    return r
        return None

    # ---- name-based search (git grep -> grep -> python walk) ----------------------
    def grep_defs(self, name: str) -> List[Tuple[str, int]]:
        if name in self._grep:
            return self._grep[name]
        pat = r"^[[:space:]]*(async[[:space:]]+def|def|class)[[:space:]]+%s[[:space:]]*[(:]" % re.escape(name)
        hits: List[Tuple[str, int]] = []
        timeout = max(0.2, min(1.0, self.deadline.left()))
        cmds = []
        if self.use_git:
            cmds.append(["git", "grep", "-n", "-E", pat, "--", "*.py"])
        cmds.append(["grep", "-rn", "-E", "--include=*.py"] +
                    [f"--exclude-dir={d}" for d in sorted(SKIP_DIRS)] + [pat, "."])
        done = False
        for cmd in cmds:
            try:
                r = subprocess.run(cmd, cwd=self.repo, capture_output=True, text=True, timeout=timeout)
            except (OSError, subprocess.SubprocessError):
                continue
            if r.returncode in (0, 1):
                for l in r.stdout.splitlines():
                    m = re.match(r"^(?:\./)?(.+?\.py):(\d+):", l)
                    if m:
                        hits.append((m.group(1), int(m.group(2))))
                done = True
                break
        if not done:
            rx = re.compile(r"^\s*(async\s+def|def|class)\s+%s\s*[(:]" % re.escape(name))
            for f in self.files():
                if f.endswith(".py") and not self.deadline.expired():
                    try:
                        with open(os.path.join(self.repo, f), "r", errors="replace") as fh:
                            for i, l in enumerate(fh, 1):
                                if rx.match(l):
                                    hits.append((f, i))
                    except OSError:
                        pass
        self._grep[name] = hits
        return hits

    def grep_resolve(self, name: str, near: FileIndex, limit: int = 3) -> List[Tuple[FileIndex, Scope]]:
        hits = self.grep_defs(name)
        if not hits or len(hits) > limit:      # unknown, or too ambiguous to be useful
            return []

        def closeness(rel: str) -> int:
            a, b = rel.split("/"), near.rel.split("/")
            n = 0
            for x, y in zip(a[:-1], b[:-1]):
                if x != y:
                    break
                n += 1
            return -n

        out = []
        for rel, line in sorted(hits, key=lambda h: closeness(h[0]))[:2]:
            fi = self.index(rel)
            if fi:
                for s in fi.scopes:
                    if s.name == name and s.def_line == line:
                        out.append((fi, s))
                        break
        return out

    # ---- calls ---------------------------------------------------------------------
    def local_def(self, fi: FileIndex, name: str, scope: Optional[Scope]) -> Optional[Scope]:
        chain, s = set(), scope
        while s is not None:
            chain.add(id(s))
            s = s.parent
        cands = fi.by_name.get(name, [])
        nested = [c for c in cands if c.parent is not None and id(c.parent) in chain]
        top = [c for c in cands if c.parent is None]
        return (nested or top or [None])[0]

    def ctor_target(self, fi: FileIndex, s: Scope) -> Tuple[FileIndex, Scope]:
        if s.kind == "class":
            init = fi.by_qual.get(f"{s.qual}.__init__")
            return (fi, init) if init else (fi, s)
        return fi, s

    def resolve_call(self, call: ast.Call, fi: FileIndex, scope: Optional[Scope]) -> List[Tuple[FileIndex, Scope]]:
        f = call.func
        if isinstance(f, ast.Name):
            if f.id in BUILTIN_NAMES:
                return []
            s = self.local_def(fi, f.id, scope)
            r = (fi, s) if s else self.import_symbol(f.id, fi)
            if r:
                return [self.ctor_target(*r)]
            return [self.ctor_target(*x) for x in self.grep_resolve(f.id, fi)]
        if isinstance(f, ast.Attribute):
            attr, base, cls = f.attr, f.value, enclosing_class(scope)
            if isinstance(base, ast.Name) and base.id in ("self", "cls") and cls:
                r = self.class_lookup(fi, cls, attr)
                return [r] if r else []
            if (isinstance(base, ast.Call) and isinstance(base.func, ast.Name)
                    and base.func.id == "super" and cls):
                r = self.class_lookup(fi, cls, attr, skip_self=True)
                return [r] if r else []
            if isinstance(base, ast.Name):
                target = self.index(self.module_for_local(base.id, fi))
                if target:
                    s = self.lookup_top(target, attr)
                    if s:
                        return [self.ctor_target(target, s)]
                cr = self.resolve_class(base.id, fi)
                if cr:
                    r = self.class_lookup(cr[0], cr[1], attr)
                    if r:
                        return [r]
            if attr in COMMON_ATTRS or len(attr) < 4:
                return []
            return [self.ctor_target(*x) for x in self.grep_resolve(attr, fi)]
        return []


# --------------------------------------------------------------------------------------
# 4. Engine: frames -> candidates
# --------------------------------------------------------------------------------------
@dataclass
class Result:
    text: str
    tokens: int
    elapsed_ms: int
    blocks: List[dict]
    notes: List[str]
    truncated: bool


class Engine:
    def __init__(self, repo: str, failure_text: str, hint_text: str = "", budget: int = DEFAULT_BUDGET,
                 deadline_s: float = DEFAULT_DEADLINE_S, profile: str = "default", use_git: bool = True):
        self.t0 = time.monotonic()
        self.deadline = Deadline(deadline_s)
        self.repo = repo
        self.failure = failure_text
        self.hint = hint_text
        self.profile = profile
        self.budget = int(budget * (1.5 if profile == "wide" else 1.0))
        self.callee_limit = 14 if profile == "wide" else 8
        self.res = Resolver(repo, self.deadline, use_git)
        self.cands: Dict[str, Candidate] = {}
        self.notes: List[str] = []
        self.truncated = False

    # ---- candidate bookkeeping ----------------------------------------------------
    def add(self, key: str, path: str, reason: str, score: float, variants: List[Variant]) -> None:
        if not variants:
            return
        cur = self.cands.get(key)
        if cur is None:
            self.cands[key] = Candidate(key, path, reason, score, variants)
        else:
            if reason not in cur.reason:
                cur.reason += "; " + reason
            cur.score = max(cur.score, score)
            if len(variants[0].text) > len(cur.variants[0].text):
                cur.variants = variants

    def add_scope(self, fi: FileIndex, s: Scope, reason: str, score: float,
                  focus: Optional[int] = None, full_cap: int = 120) -> None:
        self.add(f"{fi.rel}::{s.qual}", fi.rel, reason, score, fi.scope_variants(s, focus, full_cap))

    def out_of_time(self, what: str) -> bool:
        if self.deadline.expired():
            if not self.truncated:
                self.notes.append(f"time budget reached while {what}; context may be incomplete")
            self.truncated = True
            return True
        return False

    # ---- main --------------------------------------------------------------------
    def run(self) -> Result:
        frames = parse_frames(self.failure)
        for f in frames:
            f.rel = self.res.to_rel(f.path)
            if f.rel:
                parts = f.rel.split("/")
                base = parts[-1]
                f.is_test = (base.startswith("test_") or base.endswith("_test.py") or base == "conftest.py"
                             or "tests" in parts[:-1] or "test" in parts[:-1])
        ext = [f for f in frames if not f.rel]
        if ext:
            self.notes.append(f"{len(ext)} frame(s) are outside the repo (libraries/stdlib) and were skipped")
        py = [f for f in frames if f.rel and f.rel.endswith(".py")]
        non_py = [f for f in frames if f.rel and not f.rel.endswith(".py")]
        src = [f for f in py if not f.is_test]
        tests = [f for f in py if f.is_test]
        if not py:
            self.notes.append("no in-repo Python frames found in the failure output")

        focus: List[Tuple[FileIndex, Scope, int, float, str]] = []
        for f in py:
            if self.out_of_time("reading frames"):
                break
            fi = self.res.index(f.rel)
            if not fi:
                continue
            if f.is_test:
                score = 90.0 if f is tests[0] else 72.0
                label = "failing test" if f is tests[0] else "test helper in the call chain"
            else:
                rank = len(src) - 1 - src.index(f)
                score = max(62.0, 100.0 - 6 * rank)
                label = ("innermost source frame (error raised here)" if rank == 0
                         else f"call-chain frame, {rank} step(s) above the error")
            scope = fi.enclosing(f.line) if fi.tree else None
            if scope and scope.kind == "function":
                self.add_scope(fi, scope, label, score, f.line)
                focus.append((fi, scope, f.line, score, label))
            else:
                self.add(f"{fi.rel}:{f.line}", fi.rel, label + " (module level)", score, fi.window_variants(f.line))

        if frames and not src and tests:
            self.notes.append("failure is only visible inside the test (assertion-style); "
                              "the code under test was found by following the test's calls")

        expand = sorted(focus, key=lambda x: -x[3])[: (8 if self.profile == "wide" else 5)]
        per_frame = max(2, self.callee_limit // max(1, len(expand)))
        for fi, scope, line, score, label in expand:
            self.expand_scope(fi, scope, line, frame_score=score, boost=(20 if not src else 0), limit=per_frame)

        self.hint_candidates(py)
        self.asset_candidates(non_py, expand)
        main_rel = (src[-1] if src else (tests[0] if tests else None))
        if main_rel:
            fi = self.res.index(main_rel.rel)
            if fi:
                self.add(f"{fi.rel}::skeleton", fi.rel, "imports, constants and top-level names of the main file",
                         40.0, fi.skeleton_variants())
        return self.finish(frames, src, tests)

    # ---- expansions ----------------------------------------------------------------
    def expand_scope(self, fi: FileIndex, scope: Scope, focus_line: int, frame_score: float = 80.0,
                     boost: float = 0.0, limit: int = 4) -> None:
        # decorators applied to this function (and to enclosing scopes)
        s: Optional[Scope] = scope
        while s is not None:
            for dec in s.decorators:
                if self.out_of_time("resolving decorators"):
                    return
                fake = ast.Call(func=dec.func if isinstance(dec, ast.Call) else dec, args=[], keywords=[])
                ast.copy_location(fake, dec)
                for tfi, ts in self.res.resolve_call(fake, fi, s)[:1]:
                    self.add_scope(tfi, ts, f"decorator on {s.qual}", 66.0, None, 60)
            s = s.parent
        # overridden base-class method
        cls = enclosing_class(scope)
        if cls is not None and scope.parent is cls:
            r = self.res.class_lookup(fi, cls, scope.name, skip_self=True)
            if r:
                self.add_scope(r[0], r[1], f"base-class version of {scope.qual}", 68.0, None, 80)
        # callees: nearest-before-the-failure first
        calls = [n for n in ast.walk(scope.node) if isinstance(n, ast.Call)]
        calls.sort(key=lambda c: (0, focus_line - c.lineno) if c.lineno <= focus_line else (1, c.lineno - focus_line))
        used, seen_keys = 0, set()
        for call in calls[:40]:
            if used >= limit or self.out_of_time("following calls"):
                break
            for tfi, ts in self.res.resolve_call(call, fi, scope):
                key = f"{tfi.rel}::{ts.qual}"
                if key in seen_keys or (tfi is fi and ts is scope):
                    continue
                seen_keys.add(key)
                is_super = (isinstance(call.func, ast.Attribute) and isinstance(call.func.value, ast.Call)
                            and isinstance(call.func.value.func, ast.Name) and call.func.value.func.id == "super")
                score = 0.55 * frame_score - 2 * used + (6 if call.lineno <= focus_line else 0) + (10 if is_super else 0) + boost
                self.add_scope(tfi, ts, f"called from {scope.qual} (line {call.lineno})", score, None, 40)
                used += 1

    def hint_candidates(self, py: List[Frame]) -> None:
        e_lines = "\n".join(l[1:] for l in self.failure.splitlines() if l.startswith("E "))
        names = extract_identifiers(self.hint + "\n" + e_lines, limit=5)
        base = self.res.index(py[0].rel) if py else None
        for rank, name in enumerate(names):
            if self.out_of_time("matching names from the bug report"):
                return
            hits = self.res.grep_defs(name)
            if not hits or len(hits) > 3:
                continue
            for rel, line in hits:
                fi = self.res.index(rel)
                if not fi:
                    continue
                for s in fi.scopes:
                    if s.name == name and s.def_line == line:
                        self.add_scope(fi, s, f"`{name}` is mentioned in the bug report/error", 48.0 - 2 * rank, None, 40)
                        break

    def asset_candidates(self, non_py: List[Frame], expand) -> None:
        seen = set()
        for f in non_py:
            fi = self.res.index(f.rel)
            if fi:
                seen.add(f.rel)
                self.add(f"{f.rel}:{f.line}", f.rel, "non-Python file in the stack trace", 64.0, fi.window_variants(f.line))
        count = 0
        for m in _ASSET_RE.finditer(self.failure):
            if count >= 5 or self.out_of_time("looking for referenced files"):
                break
            rel = self.res.to_rel(m.group(1))
            if not rel or rel.endswith(".py") or rel in seen:
                continue
            fi = self.res.index(rel)
            if not fi:
                continue
            seen.add(rel)
            line = int(m.group(2)) if m.group(2) else None
            self.add(f"{rel}:{line or 'head'}", rel, "file named in the error output",
                     62.0 if line else 50.0, fi.window_variants(line))
            count += 1
        lit = re.compile(r"^[\w./\\-]+\.%s$" % ASSET_EXT)
        for fi, scope, _, _, _ in expand:
            added = 0
            for n in ast.walk(scope.node):
                if added >= 3:
                    break
                if isinstance(n, ast.Constant) and isinstance(n.value, str) and len(n.value) < 120 and lit.match(n.value):
                    cands = self.res.by_basename(os.path.basename(n.value))
                    if len(cands) == 1 and cands[0] not in seen and not cands[0].endswith(".py"):
                        a = self.res.index(cands[0])
                        if a:
                            seen.add(cands[0])
                            self.add(f"{cands[0]}:head", cands[0], f"file referenced inside {scope.qual}", 52.0, a.window_variants(None))
                            added += 1

    # ---- packing + output ----------------------------------------------------------
    def finish(self, frames, src, tests) -> Result:
        chosen, used = pack(list(self.cands.values()), self.budget)
        kept = []
        for c, v in chosen:
            host = next((c2 for c2, v2 in chosen if c2 is not c and c2.path == c.path and v2.contiguous
                         and v2.start <= v.start and v2.end >= v.end
                         and (v2.end - v2.start, c2.score) > (v.end - v.start, 0)), None)
            if host is not None:
                if c.reason not in host.reason:
                    host.reason += "; " + c.reason
                continue
            kept.append((c, v))
        chosen = kept
        by_file: Dict[str, float] = {}
        for c, _ in chosen:
            by_file[c.path] = max(by_file.get(c.path, 0), c.score)
        chosen.sort(key=lambda cv: (-by_file[cv[0].path], cv[0].path, cv[1].start))
        used = sum(v.tokens for _, v in chosen)
        parts, blocks = [], []
        for c, v in chosen:
            parts.append(f"--- {c.path} (lines {v.start}-{v.end}) - {c.reason}\n{v.text}")
            blocks.append({"path": c.path, "start": v.start, "end": v.end, "level": v.level,
                           "reason": c.reason, "score": round(c.score, 1), "tokens": v.tokens})
        exc = exception_summary(self.failure)
        head = (f"=== Auto-selected code context (~{used} tokens, {len(blocks)} blocks)"
                + (f" | error: {exc}" if exc else "") + " ===")
        notes = ("\n[notes] " + " | ".join(self.notes)) if self.notes else ""
        text = head + "\n\n" + "\n\n".join(parts) + notes
        return Result(text, used, int((time.monotonic() - self.t0) * 1000), blocks, self.notes, self.truncated)


def pack(cands: List[Candidate], budget: int) -> Tuple[List[Tuple[Candidate, Variant]], int]:
    """Pass 1: every candidate gets its leanest form (coverage). Pass 2: upgrade best-first."""
    ordered = sorted(cands, key=lambda c: -c.score)
    chosen: Dict[str, int] = {}
    remaining = budget
    for c in ordered:
        lean = c.variants[-1]
        if lean.tokens <= remaining:
            chosen[c.key] = len(c.variants) - 1
            remaining -= lean.tokens
    for c in ordered:
        i = chosen.get(c.key)
        if i is None:
            continue
        while i > 0:
            extra = c.variants[i - 1].tokens - c.variants[i].tokens
            if extra > remaining:
                break
            remaining -= extra
            i -= 1
        chosen[c.key] = i
    return [(c, c.variants[chosen[c.key]]) for c in ordered if c.key in chosen], budget - remaining


# --------------------------------------------------------------------------------------
# Public API
# --------------------------------------------------------------------------------------
def extract_repository_context(repo_dir: str, failure_text: str, bug_description: str = "",
                               budget_tokens: int = DEFAULT_BUDGET, deadline_s: float = DEFAULT_DEADLINE_S,
                               profile: str = "default", use_git: bool = True) -> dict:
    """profile: "default" (~budget) or "wide" (1.5x budget, more callees; use for Ultra escalation)."""
    r = Engine(repo_dir, failure_text[:200_000], bug_description, budget_tokens, deadline_s, profile, use_git).run()
    return r.__dict__


def fetch_symbols(repo_dir: str, specs: List[str], budget_tokens: int = 2500,
                  deadline_s: float = DEFAULT_DEADLINE_S, use_git: bool = True) -> dict:
    """Deterministic 'give me more' lookup. Spec = 'path.py::Class.method' or a bare name.
    Used for round 2: the replanner names symbols it wants; we only return ones that really exist."""
    eng = Engine(repo_dir, "", "", budget_tokens, deadline_s, "default", use_git)
    for spec in specs:
        if "::" in spec:
            rel, qual = spec.split("::", 1)
            fi = eng.res.index(eng.res.to_rel(rel))
            s = fi.by_qual.get(qual) if fi else None
            if fi and s:
                eng.add_scope(fi, s, "requested by the planner", 80.0, None, 120)
            else:
                eng.notes.append(f"requested symbol not found: {spec}")
        else:
            hits = eng.res.grep_defs(spec)[:3]
            found = False
            for rel, line in hits:
                fi = eng.res.index(rel)
                for s in (fi.scopes if fi else []):
                    if s.name == spec and s.def_line == line:
                        eng.add_scope(fi, s, "requested by the planner", 80.0, None, 120)
                        found = True
            if not found:
                eng.notes.append(f"requested symbol not found: {spec}")
    return eng.finish([], [], []).__dict__


def main(argv: Optional[List[str]] = None) -> int:
    ap = argparse.ArgumentParser(description="PatchTree context engine")
    ap.add_argument("--repo", required=True)
    ap.add_argument("--budget", type=int, default=DEFAULT_BUDGET)
    ap.add_argument("--deadline", type=float, default=DEFAULT_DEADLINE_S)
    ap.add_argument("--profile", default="default", choices=["default", "wide"])
    ap.add_argument("--hint-file", default="")
    ap.add_argument("--symbols", action="append", default=[])
    ap.add_argument("--no-git", action="store_true")
    a = ap.parse_args(argv)
    if a.symbols:
        out = fetch_symbols(a.repo, a.symbols, a.budget, a.deadline, not a.no_git)
    else:
        hint = ""
        if a.hint_file and os.path.isfile(a.hint_file):
            with open(a.hint_file, "r", errors="replace") as fh:
                hint = fh.read()
        failure = sys.stdin.read()
        out = extract_repository_context(a.repo, failure, hint, a.budget, a.deadline, a.profile, not a.no_git)
    sys.stdout.write(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())

"""
Linear-time O(N) self-contained YAML/JSON subset parser for Hubverse model metadata files.

Supports block mappings (including arbitrary nesting), block sequences (`- item` and `- k: v`),
block scalars (`|` / `>` with chomping modifiers), flow sequences/mappings (`[...]` / `{...}`
with nested structures, trailing commas, and unquoted scalars), multi-line quoted scalars,
wrapped unquoted scalars, inline `# comments`, and UTF-8 BOM stripping — zero third-party deps.
"""

from __future__ import annotations

import json
import re
from typing import Any, Dict, List, Optional, Tuple

_YAML_QUOTED_KEY_RE = re.compile(
    r'^(?:"((?:[^"\\]|\\.)*)"|\'((?:[^\']|\'\')*)\')[ \t]*:(?:[ \t]+(.*))?$'
)
# Characters that cannot start a plain (unquoted) YAML key
_PLAIN_KEY_BAD_START = frozenset("?:,[]{}#&*!|>'\"%@`")


def match_yaml_key_val(line_stripped: str) -> Optional[Tuple[str, str]]:
    """
    Split a trimmed YAML mapping line into `(key, value_rest)` or return `None`.

    Plain keys may contain spaces and non-ASCII characters (`team name:`, `équipe:`); the key ends at
    the first `:` followed by whitespace or end of line. Linear in the line length.
    """
    s = line_stripped
    if not s:
        return None
    c0 = s[0]
    if c0 in ('"', "'"):
        m = _YAML_QUOTED_KEY_RE.match(s)
        if not m:
            return None
        if m.group(1) is not None:
            key = _unquote_double('"' + m.group(1) + '"')
        else:
            key = m.group(2).replace("''", "'")
        return key, (m.group(3) if m.group(3) is not None else "")
    if c0 in _PLAIN_KEY_BAD_START or c0.isspace() or (c0 == "-" and (len(s) == 1 or s[1] in " \t")):
        return None
    n = len(s)
    j = s.find(":")
    while j != -1 and j + 1 < n and s[j + 1] not in " \t":
        j = s.find(":", j + 1)
    if j == -1:
        return None
    key = s[:j].rstrip()
    if not key or " #" in key or "\t#" in key:
        return None
    return key, s[j + 1:].lstrip(" \t")


def strip_yaml_inline_comment(s: str) -> str:
    """
    Strip an inline `# ...` comment outside quoted strings.

    Unquoted scalars cannot enter quote mode mid-token, so apostrophes in plain text
    (e.g. `We don't # note`) do not suppress comment stripping or break quote tracking.
    """
    if not s:
        return ""
    lead = s.lstrip()
    if lead.startswith('"'):
        in_dq = True
        esc = False
        offset = len(s) - len(lead)
        i = offset + 1
        while i < len(s):
            ch = s[i]
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                in_dq = False
                i += 1
                break
            i += 1
        if not in_dq:
            while i < len(s):
                if s[i] == "#" and (i == 0 or s[i - 1].isspace()):
                    return s[:i].rstrip()
                i += 1
        return s.rstrip()

    if lead.startswith("'"):
        in_sq = True
        offset = len(s) - len(lead)
        i = offset + 1
        while i < len(s):
            if s[i] == "'":
                if i + 1 < len(s) and s[i + 1] == "'":
                    i += 2
                    continue
                in_sq = False
                i += 1
                break
            i += 1
        if not in_sq:
            while i < len(s):
                if s[i] == "#" and (i == 0 or s[i - 1].isspace()):
                    return s[:i].rstrip()
                i += 1
        return s.rstrip()

    for i, ch in enumerate(s):
        if ch == "#" and (i == 0 or s[i - 1].isspace()):
            return s[:i].rstrip()
    return s.rstrip()


def _advance_quote_state(chunk: str, quote: Optional[str], esc: bool) -> Tuple[Optional[str], bool]:
    """Incrementally advance quote state over `chunk` in O(len(chunk)) time."""
    i = 0
    n = len(chunk)
    if quote is None:
        t = chunk.lstrip()
        if not t or t[0] not in ('"', "'"):
            return None, False
        quote = t[0]
        i = len(chunk) - len(t) + 1
        esc = False

    while i < n:
        ch = chunk[i]
        if quote == '"':
            if esc:
                esc = False
            elif ch == "\\":
                esc = True
            elif ch == '"':
                return None, False
        else:  # quote == "'"
            if ch == "'":
                if i + 1 < n and chunk[i + 1] == "'":
                    i += 2
                    continue
                return None, False
        i += 1
    return quote, esc


def _unquote_double(raw_quoted: str) -> str:
    inner = raw_quoted[1:-1]
    inner_norm = re.sub(r"\\\s+\\\s*", " ", inner)
    try:
        val = json.loads('"' + inner_norm + '"')
        return val if isinstance(val, str) else inner_norm
    except Exception:
        return (
            inner_norm.replace('\\"', '"')
            .replace("\\n", "\n")
            .replace("\\t", "\t")
            .replace("\\ ", " ")
            .replace("\\\\", "\\")
        )


def parse_yaml_scalar(val: str) -> Any:
    """Parse a single YAML scalar token (quoted, boolean, null, int, float, or plain string)."""
    v = strip_yaml_inline_comment(val.strip())
    if not v:
        return None
    if v.startswith('"') and v.endswith('"') and len(v) >= 2:
        return _unquote_double(v)
    if v.startswith("'") and v.endswith("'") and len(v) >= 2:
        return v[1:-1].replace("''", "'")
    low = v.lower()
    if low in ("true", "yes"):
        return True
    if low in ("false", "no"):
        return False
    if low in ("null", "~"):
        return None
    if re.fullmatch(r"-?\d+", v):
        digits = v.lstrip("-")
        if len(digits) > 1 and digits.startswith("0"):
            return v
        return int(v)
    if re.fullmatch(r"-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?", v) and ("." in v or "e" in low):
        try:
            return float(v)
        except ValueError:
            pass
    return v


def parse_yaml_flow(text: str) -> Any:
    """
    Recursive-descent O(N) parser for YAML flow collections (`{...}`, `[...]`).

    Supports nested objects/lists, single- & double-quoted keys/values containing
    commas/colons/brackets, unquoted string values, booleans/nulls/numbers, and trailing commas.
    """
    src = text.strip()
    n = len(src)

    def skip_ws_and_comments(pos: int) -> int:
        while pos < n:
            ch = src[pos]
            if ch.isspace():
                pos += 1
            elif ch == "#" and (pos == 0 or src[pos - 1].isspace()):
                nl = src.find("\n", pos)
                pos = n if nl == -1 else nl + 1
            else:
                break
        return pos

    def read_quoted(pos: int) -> Tuple[str, int]:
        q = src[pos]
        if q == '"':
            i = pos + 1
            esc = False
            while i < n:
                ch = src[i]
                if esc:
                    esc = False
                elif ch == "\\":
                    esc = True
                elif ch == '"':
                    return _unquote_double(src[pos:i + 1]), i + 1
                i += 1
            raise ValueError("Unterminated double-quoted string in flow YAML")
        i = pos + 1
        buf: List[str] = []
        while i < n:
            ch = src[i]
            if ch == "'":
                if i + 1 < n and src[i + 1] == "'":
                    buf.append("'")
                    i += 2
                    continue
                return "".join(buf), i + 1
            buf.append(ch)
            i += 1
        raise ValueError("Unterminated single-quoted string in flow YAML")

    def read_plain(pos: int, stop_chars: str) -> Tuple[Any, int]:
        start = pos
        while pos < n and src[pos] not in stop_chars and src[pos] != "\n":
            if src[pos] == "#" and pos > start and src[pos - 1].isspace():
                break
            pos += 1
        token = src[start:pos].strip()
        if not token:
            return None, pos
        return parse_yaml_scalar(token), pos

    def parse_val(pos: int, stop_chars: str) -> Tuple[Any, int]:
        pos = skip_ws_and_comments(pos)
        if pos >= n or src[pos] in stop_chars:
            return None, pos
        ch = src[pos]
        if ch == "{":
            return parse_obj(pos)
        if ch == "[":
            return parse_arr(pos)
        if ch in ('"', "'"):
            s_val, next_pos = read_quoted(pos)
            next_ws = skip_ws_and_comments(next_pos)
            if next_ws < n and src[next_ws] not in stop_chars:
                # Quoted key/prefix followed cleanly only if stop_chars reached
                pass
            return s_val, next_pos
        return read_plain(pos, stop_chars)

    def parse_arr(pos: int) -> Tuple[List[Any], int]:
        assert src[pos] == "["
        pos += 1
        items: List[Any] = []
        while pos < n:
            pos = skip_ws_and_comments(pos)
            if pos >= n:
                raise ValueError("Unterminated flow sequence")
            if src[pos] == "]":
                return items, pos + 1
            val, pos = parse_val(pos, ",]")
            items.append(val)
            pos = skip_ws_and_comments(pos)
            if pos < n and src[pos] == ",":
                pos += 1
                continue
            if pos < n and src[pos] == "]":
                return items, pos + 1
            raise ValueError(f"Expected ',' or ']' at position {pos}")
        raise ValueError("Unterminated flow sequence")

    def parse_key(pos: int) -> Tuple[str, int]:
        pos = skip_ws_and_comments(pos)
        if pos >= n:
            raise ValueError("Expected key in flow mapping")
        if src[pos] in ('"', "'"):
            k, next_pos = read_quoted(pos)
            return str(k), next_pos
        start = pos
        while pos < n and src[pos] not in (":", ",", "}"):
            pos += 1
        raw_k = src[start:pos].strip()
        if not raw_k:
            raise ValueError(f"Empty key at position {start}")
        return raw_k, pos

    def parse_obj(pos: int) -> Tuple[Dict[str, Any], int]:
        assert src[pos] == "{"
        pos += 1
        obj: Dict[str, Any] = {}
        while pos < n:
            pos = skip_ws_and_comments(pos)
            if pos >= n:
                raise ValueError("Unterminated flow mapping")
            if src[pos] == "}":
                return obj, pos + 1
            k, pos = parse_key(pos)
            pos = skip_ws_and_comments(pos)
            if pos >= n or src[pos] != ":":
                raise ValueError(f"Expected ':' after key {k!r}")
            pos += 1
            val, pos = parse_val(pos, ",}")
            obj[k] = val
            pos = skip_ws_and_comments(pos)
            if pos < n and src[pos] == ",":
                pos += 1
                continue
            if pos < n and src[pos] == "}":
                return obj, pos + 1
            raise ValueError(f"Expected ',' or '}}' at position {pos}")
        raise ValueError("Unterminated flow mapping")

    try:
        if src.startswith("{"):
            val, end = parse_obj(0)
            if skip_ws_and_comments(end) == n:
                return val
        elif src.startswith("["):
            val, end = parse_arr(0)
            if skip_ws_and_comments(end) == n:
                return val
    except ValueError:
        pass

    try:
        return json.loads(src)
    except Exception:
        return src


_TAB_INDENT_WIDTH = 2


def _expand_leading_tabs(line: str) -> str:
    """Expand tabs in a line's leading indentation (tab-indented lists/maps), leaving the content untouched."""
    body = line.lstrip(" \t")
    lead = line[: len(line) - len(body)]
    if "\t" not in lead:
        return line
    return lead.expandtabs(_TAB_INDENT_WIDTH) + body


def parse_yaml_mapping(text: str) -> Dict[str, Any]:
    """Parse a Hubverse YAML or JSON metadata document into a dictionary in strict O(N) time."""
    if not text:
        return {}
    if text.startswith("\ufeff"):
        text = text.lstrip("\ufeff")

    stripped_all = text.strip()
    if stripped_all.startswith("{"):
        parsed_flow = parse_yaml_flow(stripped_all)
        if isinstance(parsed_flow, dict):
            return parsed_flow

    raw_lines = text.splitlines()
    if "\t" in text:
        raw_lines = [_expand_leading_tabs(l) for l in raw_lines]
    n = len(raw_lines)

    def next_significant(idx: int) -> int:
        while idx < n:
            s = raw_lines[idx].strip()
            if not s or s.startswith("#") or s in ("---", "..."):
                idx += 1
                continue
            break
        return idx

    first_sig = next_significant(0)
    if first_sig >= n:
        return {}

    def consume_flow(first_chunk: str, idx: int) -> Tuple[Any, int]:
        buf: List[str] = []
        stack: List[str] = []
        in_sq = False
        in_dq = False
        esc = False
        # Last significant char outside quotes: a quote only opens a quoted scalar at the start of a
        # flow token, so an apostrophe inside a plain value (`{name: O'Brien}`) is literal text.
        prev_sig = ""

        def scan_chunk(chunk: str) -> str:
            nonlocal in_sq, in_dq, esc, prev_sig
            i = 0
            m = len(chunk)
            while i < m:
                ch = chunk[i]
                if in_dq:
                    if esc:
                        esc = False
                    elif ch == "\\":
                        esc = True
                    elif ch == '"':
                        in_dq = False
                        prev_sig = ch
                elif in_sq:
                    if ch == "'":
                        if i + 1 < m and chunk[i + 1] == "'":
                            i += 2
                            continue
                        in_sq = False
                        prev_sig = ch
                elif ch == "#" and (i == 0 or chunk[i - 1].isspace()):
                    return chunk[:i].rstrip()
                elif ch in ('"', "'") and prev_sig in ("", "[", "{", ",", ":"):
                    in_dq = ch == '"'
                    in_sq = ch == "'"
                else:
                    if ch in "[{":
                        stack.append("]" if ch == "[" else "}")
                    elif ch in "]}" and stack and ch == stack[-1]:
                        stack.pop()
                    if not ch.isspace():
                        prev_sig = ch
                i += 1
            return chunk

        buf.append(scan_chunk(first_chunk))
        while stack and idx < n:
            nl = raw_lines[idx]
            buf.append(scan_chunk(nl))
            idx += 1
        return parse_yaml_flow("\n".join(buf)), idx

    def consume_block_scalar(header: str, idx: int, parent_indent: int) -> Tuple[str, int]:
        style = header[0]
        chomp = "strip" if "-" in header else ("keep" if "+" in header else "clip")
        block_lines: List[str] = []
        block_indent: Optional[int] = None
        while idx < n:
            nl = raw_lines[idx]
            if not nl.strip():
                block_lines.append("")
                idx += 1
                continue
            ind = len(nl) - len(nl.lstrip(" "))
            if ind <= parent_indent:
                break
            if block_indent is None:
                block_indent = ind
            block_lines.append(nl[min(len(nl), block_indent):].rstrip())
            idx += 1

        if chomp == "strip":
            while block_lines and not block_lines[-1]:
                block_lines.pop()
            trailing = ""
        elif chomp == "keep":
            trailing = ""
        else:
            while block_lines and not block_lines[-1]:
                block_lines.pop()
            trailing = ""

        if style == "|":
            return "\n".join(block_lines) + trailing, idx

        paras: List[str] = []
        cur: List[str] = []
        for bl in block_lines:
            if not bl:
                if cur:
                    paras.append(" ".join(cur))
                    cur = []
                paras.append("")
            else:
                cur.append(bl.strip())
        if cur:
            paras.append(" ".join(cur))
        return "\n".join(paras) + trailing, idx

    def consume_scalar_lines(
        first_val: str, idx: int, parent_indent: int, opened_inline: bool = False
    ) -> Tuple[Any, int]:
        parts = [first_val]
        quote, esc = _advance_quote_state(first_val, None, False)
        # A plain scalar opened on its key/dash line continues on EVERY following line indented deeper
        # than its parent, whatever that line looks like (`- step`, `Note: ...`), per the YAML spec.
        plain_inline = opened_inline and not first_val.lstrip().startswith(('"', "'"))
        while idx < n:
            nl = raw_lines[idx]
            unclosed = quote is not None
            if not nl.strip():
                if unclosed:
                    parts.append("")
                    quote, esc = _advance_quote_state("", quote, esc)
                    idx += 1
                    continue
                k = idx + 1
                while k < n and not raw_lines[k].strip():
                    k += 1
                if (
                    k < n
                    and (len(raw_lines[k]) - len(raw_lines[k].lstrip(" "))) > parent_indent
                    and not raw_lines[k].lstrip().startswith("#")
                    and (
                        plain_inline
                        or (
                            not raw_lines[k].lstrip().startswith("- ")
                            and raw_lines[k].lstrip() != "-"
                            and match_yaml_key_val(raw_lines[k].lstrip(" ")) is None
                        )
                    )
                ):
                    idx = k
                    continue
                break

            if not unclosed and nl.lstrip().startswith("#"):
                idx += 1
                continue
            ns = nl.lstrip(" ")
            nind = len(nl) - len(ns)
            if not unclosed:
                if nind <= parent_indent:
                    break
                if not plain_inline and (ns.startswith("- ") or ns == "-" or match_yaml_key_val(ns) is not None):
                    break
                cleaned = strip_yaml_inline_comment(ns)
            else:
                cleaned = ns.rstrip()
                quote, esc = _advance_quote_state(cleaned, quote, esc)
            parts.append(cleaned)
            idx += 1

        joined = " ".join(p for p in parts if p != "")
        return parse_yaml_scalar(joined), idx

    def parse_value_after_key(rest: str, idx: int, key_indent: int) -> Tuple[Any, int]:
        raw_rest = rest.strip()
        if raw_rest.startswith("[") or raw_rest.startswith("{"):
            return consume_flow(raw_rest, idx)

        q_state, _ = _advance_quote_state(raw_rest, None, False)
        val = raw_rest if q_state is not None else strip_yaml_inline_comment(raw_rest)

        if re.match(r"^[|>][-+]?\d*$", val):
            return consume_block_scalar(val, idx, key_indent)

        if not val:
            j = idx
            while j < n and (not raw_lines[j].strip() or raw_lines[j].lstrip().startswith("#")):
                j += 1
            if j >= n:
                return None, j
            next_line = raw_lines[j]
            next_s = next_line.lstrip(" ")
            next_ind = len(next_line) - len(next_s)
            if next_ind < key_indent:
                return None, j

            if next_s.startswith("[") or next_s.startswith("{"):
                return consume_flow(next_s, j + 1)

            if next_s.startswith("- ") or next_s == "-":
                if next_ind >= key_indent:
                    return parse_block_list(j, next_ind)
                return None, j

            if next_ind > key_indent:
                if match_yaml_key_val(next_s) is not None:
                    return parse_block_map(j, next_ind)
                q_next, _ = _advance_quote_state(next_s, None, False)
                sv_clean = next_s if q_next is not None else strip_yaml_inline_comment(next_s)
                return consume_scalar_lines(sv_clean, j + 1, key_indent)

            return None, j

        return consume_scalar_lines(val, idx, key_indent, opened_inline=True)

    def parse_block_list(idx: int, list_indent: int) -> Tuple[List[Any], int]:
        items: List[Any] = []
        while idx < n:
            nl = raw_lines[idx]
            stripped = nl.strip()
            if not stripped or stripped.startswith("#") or stripped in ("---", "..."):
                idx += 1
                continue
            ns = nl.lstrip(" ")
            nind = len(nl) - len(ns)
            if nind < list_indent:
                break
            if nind > list_indent or not (ns.startswith("- ") or ns == "-"):
                break

            after_dash = ns[1:].strip() if ns == "-" else ns[2:].lstrip(" ")
            # Column where the item content starts (`-   name: x` keys sit at nind + 4)
            dash_content_indent = nind + (len(ns) - len(after_dash) if after_dash else 2)
            idx += 1

            sub_kv = match_yaml_key_val(after_dash)
            item_is_dict = sub_kv is not None
            if not after_dash:
                k = idx
                while k < n and (not raw_lines[k].strip() or raw_lines[k].lstrip().startswith("#")):
                    k += 1
                if k < n:
                    ks = raw_lines[k].lstrip(" ")
                    kind = len(raw_lines[k]) - len(ks)
                    if kind > list_indent and match_yaml_key_val(ks) is not None:
                        item_is_dict = True
                    elif kind > list_indent and (ks.startswith("- ") or ks == "-"):
                        sub_list, idx = parse_block_list(k, kind)
                        items.append(sub_list)
                        continue
                    elif kind > list_indent:
                        q_k, _ = _advance_quote_state(ks, None, False)
                        sv_k = ks if q_k is not None else strip_yaml_inline_comment(ks)
                        v_item, idx = consume_scalar_lines(sv_k, k + 1, list_indent)
                        items.append(v_item)
                        continue
                    else:
                        items.append(None)
                        idx = k
                        continue
                else:
                    items.append(None)
                    idx = k
                    continue

            if item_is_dict:
                obj: Dict[str, Any] = {}
                if sub_kv is not None:
                    sk, sv = sub_kv
                    obj[sk], idx = parse_value_after_key(sv, idx, dash_content_indent)
                while idx < n:
                    sl = raw_lines[idx]
                    sl_strip = sl.strip()
                    if not sl_strip or sl_strip.startswith("#") or sl_strip in ("---", "..."):
                        idx += 1
                        continue
                    ss = sl.lstrip(" ")
                    sind = len(sl) - len(ss)
                    if sind <= list_indent or ss.startswith("- ") or ss == "-":
                        break
                    skv = match_yaml_key_val(ss)
                    if skv is not None:
                        sk, sv = skv
                        idx += 1
                        obj[sk], idx = parse_value_after_key(sv, idx, sind)
                    else:
                        idx += 1
                items.append(obj)
            else:
                if after_dash.startswith("[") or after_dash.startswith("{"):
                    v_item, idx = consume_flow(after_dash, idx)
                    items.append(v_item)
                else:
                    q_ad, _ = _advance_quote_state(after_dash, None, False)
                    sv_clean = after_dash if q_ad is not None else strip_yaml_inline_comment(after_dash)
                    v_item, idx = consume_scalar_lines(sv_clean, idx, list_indent, opened_inline=True)
                    items.append(v_item)
        return items, idx

    def parse_block_map(idx: int, map_indent: int) -> Tuple[Dict[str, Any], int]:
        out: Dict[str, Any] = {}
        while idx < n:
            line = raw_lines[idx]
            stripped = line.strip()
            if not stripped or stripped.startswith("#") or stripped in ("---", "..."):
                idx += 1
                continue
            s = line.lstrip(" ")
            ind = len(line) - len(s)
            if ind < map_indent:
                break
            if ind > map_indent or s.startswith("-") or s.startswith("#"):
                # Ignore unexpected over-indented orphan lines within this block
                if ind == map_indent and (s.startswith("-") or s == "-"):
                    break
                idx += 1
                continue
            kv = match_yaml_key_val(s)
            if kv is None:
                idx += 1
                continue
            key, rest = kv
            idx += 1
            out[key], idx = parse_value_after_key(rest, idx, map_indent)
        return out, idx

    # Infer minimum key indent at top level cleanly (matching legacy indent tolerance)
    key_indents = [
        len(l) - len(l.lstrip(" "))
        for l in raw_lines
        if l.strip()
        and not l.lstrip().startswith("#")
        and l.strip() not in ("---", "...")
        and not l.lstrip().startswith("-")
        and match_yaml_key_val(l.lstrip()) is not None
    ]
    top_indent = min(key_indents) if key_indents else 0
    result, _ = parse_block_map(first_sig, top_indent)
    return result

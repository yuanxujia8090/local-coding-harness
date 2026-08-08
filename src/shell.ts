// ---------------------------------------------------------------------------
// Shell / bash read-only analysis. Structural (quote-aware), not a flat regex:
// chains split on unquoted operators & newlines, heredoc bodies stripped,
// `$()` substitutions and `for/while/if` blocks unwrapped recursively.
// Pattern-ported from little-coder's shell-write.ts (scan/strip/split).
// ---------------------------------------------------------------------------

/** Walk `text` char-by-char tracking quote state; visit receives each char
 *  plus whether it sits inside a quoted run. Backslash escapes hide the next
 *  character outside quotes. This is what keeps subsequent split / write
 *  detection from firing on text that merely looks like shell syntax
 *  (`grep "a > b"` writes nothing). */
function shellScan(text: string, visit: (ch: string, index: number, quoted: boolean) => void): void {
	let quote: '"' | "'" | null = null;
	for (let i = 0; i < text.length; i++) {
		const ch = text[i];
		if (quote === null) {
			if (ch === "\\") {
				i++;
				continue;
			}
			if (ch === '"' || ch === "'") {
				quote = ch;
				continue;
			}
			visit(ch, i, false);
			continue;
		}
		if (ch === quote) {
			quote = null;
			continue;
		}
		visit(ch, i, true);
	}
}

// `<< DELIM`, `<<-DELIM`, `<<'DELIM'`, `<<"DELIM"`. `<<<` is a here-string
// (single-line data) and must never match — hence the call-site check for a
// third `<`.
const HEREDOC_START = /<<-?[ \t]*(?:'([^']*)'|"([^"]*)"|([A-Za-z_][A-Za-z0-9_]*))/;

/** Strip heredoc bodies, leaving only the opening lines. A heredoc payload is
 *  data, not shell syntax — analyzing it produces noise in both directions
 *  (`>` in `if a > b:` looks like a redirect; an apostrophe in `don't` wedges
 *  the quote scanner). The write we care about (`cat > f <<'EOF'`) always sits
 *  on the opening line, so dropping bodies loses nothing. */
function stripHeredocBodies(command: string): string {
	let out = command;
	let searchFrom = 0;
	for (let pass = 0; pass < 32; pass++) {
		const rest = out.slice(searchFrom);
		const match = HEREDOC_START.exec(rest);
		if (!match || match.index === undefined) break;
		const at = searchFrom + match.index;
		if (out[at + 2] === "<") {
			searchFrom = at + 3;
			continue;
		}
		const delimiter = match[1] ?? match[2] ?? match[3] ?? "";
		const bodyStart = out.indexOf("\n", at + match[0].length);
		if (bodyStart === -1 || !delimiter) {
			searchFrom = at + match[0].length;
			continue;
		}
		const lines = out.slice(bodyStart + 1).split("\n");
		let consumed = 0;
		let closed = false;
		for (const line of lines) {
			consumed += line.length + 1;
			if (line.trim() === delimiter) {
				closed = true;
				break;
			}
		}
		const bodyEnd = closed ? Math.min(bodyStart + consumed, out.length) : out.length;
		out = out.slice(0, at) + out.slice(bodyEnd);
		searchFrom = at;
	}
	return out;
}

/** Split a command line at top-level (unquoted) `&&`, `||`, `;`, `|`, `&` and
 *  newlines, honoring quotes. Heredoc bodies stripped first so payload text is
 *  never split into fake segments. Returns trimmed non-empty segments. */
function splitCommandChain(command: string): string[] {
	const cuts: Array<{ at: number; len: number }> = [];
	shellScan(command, (_ch, i, quoted) => {
		if (quoted) return;
		const ch = command[i];
		if (ch === ";") {
			cuts.push({ at: i, len: 1 });
		} else if (ch === "&") {
			// `2>&1` / `&>`-style fd plumbing: the `&` right after `>` is not
			// an operator, leave it inside the segment.
			if (command[i - 1] === ">") return;
			const len = command[i + 1] === "&" || command[i + 1] === ">" ? 2 : 1;
			cuts.push({ at: i, len });
		} else if (ch === "|") {
			cuts.push({ at: i, len: command[i + 1] === "|" ? 2 : 1 });
		} else if (ch === "\n") {
			cuts.push({ at: i, len: 1 });
		}
	});
	const segments: string[] = [];
	let start = 0;
	for (const cut of cuts) {
		segments.push(command.slice(start, cut.at));
		start = cut.at + cut.len;
	}
	segments.push(command.slice(start));
	return segments.map((s) => s.trim()).filter((s) => s.length > 0);
}

/**
 * Walk the command collecting the text of every `$(...)` substitution
 * (nested-aware, quote-aware). Semicolons/pipe/&& inside a body are preserved
 * by swapping them for newlines so the inner text re-parses as its own chain.
 */
function extractSubstitutions(command: string): string[] {
	const inners: string[] = [];
	shellScan(command, (_ch, i, quoted) => {
		if (quoted || command[i] !== "$" || command[i + 1] !== "(") return;
		let depth = 0;
		let inner = "";
		for (let j = i + 2; j < command.length; j++) {
			const c = command[j];
			if (c === "(") {
				depth++;
				inner += c;
				continue;
			}
			if (c === ")") {
				if (depth === 0) break;
				depth--;
				inner += c;
				continue;
			}
			if (c === ";" || c === "|" || c === "&" || c === "\n") inner += "\n";
			else inner += c;
		}
		inners.push(inner);
	});
	return inners;
}

/**
 * True when executing `segment` cannot change the filesystem (or other
 * long-lived state). Conservative by default: a command not proven read-only
 * is treated as state-changing.
 */
function isReadOnlyBashSegment(segment: string): boolean {
	const stripped = segment.trim().replace(/^!\s+/, "");
	if (!stripped) return false;

	if (/^true\b/.test(stripped) || /^:\s*$/.test(stripped)) return true;

	// Write-by-design commands. These change state even without a redirect,
	// mirroring little-coder's write-detection philosophy: code detects writes
	// structurally instead of whitelisting read-only command names.
	if (/^(?:cp|mv|rm|rmdir|touch|mkdir|mkdirp|install|ln|chmod|chown|truncate|unlink|tee|dd|tar|zip|unzip|gzip|bzip2|xz)\b/.test(stripped)) return false;
	if (/^sed\s+-i\b/.test(stripped)) return false;
	if (/^find\b/.test(stripped) && /-(?:delete|exec|execdir|ok|okdir|fprint|fprintf|fls)\b/.test(stripped)) return false;
	if (/^xargs\b/.test(stripped) && /\b(?:rm|mv|cp|touch|mkdir|ln|sed)\s+-i\b/.test(stripped)) return false;
	if (/^xargs\b/.test(stripped) && /\b(?:rm|mv|cp|touch|rmdir|mkdir)\b/.test(stripped)) return false;

	if (/^(?:git)\s+(?:add|commit|rm|mv|reset|checkout|push|pull|merge|rebase|stash|clean|restore|switch|apply|archive|format-patch)\b/.test(stripped)) return false;
	if (/^(?:curl|wget)\s+(?:-o|--output|-O)\b/.test(stripped)) return false;
	if (/^(?:npm|npx|pnpm|yarn)\s+(?:install|i|add|remove|rm|uninstall|update|upgrade|init|publish|link|dedupe)\b/.test(stripped)) return false;
	if (/^(?:apt|apt-get|brew|pip|pip3|conda)\s+(?:install|remove|purge|update|upgrade|uninstall)\b/.test(stripped)) return false;

	// Executing an arbitrary script may change state. Verification-only runs
	// (`node test.js`, `bun --test`) are the exception and stay read-only.
	if (/^(?:node|bun)\b/.test(stripped)) {
		if (/\b--test\b|\S*(?:test|spec)\S*\.(?:js|mjs|cjs|ts|mts|cts)\b/.test(stripped)) return true;
		return false;
	}

	// fd plumbing (`2>&1`, `/dev/null` redirects) and input redirection
	// (`< file`) never write a real file — normalize them away, then any
	// residual unquoted `>` means the segment writes a real file.
	const line = stripHeredocBodies(stripped)
		.replace(/[12]>(?:&[12]|\/dev\/(?:null|stdout|stderr|stdin|tty|zero|full|random|urandom))/g, " ")
		.replace(/>\s*\/dev\/(?:null|stdout|stderr|stdin|tty|zero|full|random|urandom)/g, " ")
		.replace(/[0-9]*<\s*(?:&[0-9]+|[^\s>=;|&]+)/g, " ");
	let writes = false;
	shellScan(line, (ch, _i, quoted) => {
		if (!quoted && (ch === ">" || ch === "<")) writes = true;
	});
	if (writes) return false;

	// Anything without a detectable file write is treated as read-only — a
	// deliberately permissive default. Commands like `python3 -c`, `for` loops,
	// and chains that merely print/read are let through; destructive commands
	// are caught by the structural checks above rather than by name.
	return true;
}

/**
 * True when `command` is read-only.
 *
 * Recursive structure walk:
 *  - `$()` substitutions are re-parsed as their own chains.
 *  - Compound `for`/`while`/`until`/`if` blocks are flattened onto their
 *    keyword boundaries and every inner piece must be read-only.
 *  - Every top-level `&&`/`||`/`;`/`|`/newline segment must be read-only.
 *  - `name=value` assignments are read-only on their own.
 * Anything not proven read-only is treated as state-changing (conservative).
 */
function isReadOnlyBashCommand(command: string, depth = 0): boolean {
	if (depth > 16) return false;
	const normalized = stripHeredocBodies(command.trim());
	if (!normalized) return false;

	// A bare `&` backgrounds the command (`cmd &`) — the harness cannot
	// observe side effects of a forked job, so it is not read-only. `&&`,
	// `&>` and `2>&1` are connectors, not backgrounding.
	{
		let bg = false;
		shellScan(normalized, (_ch, i, quoted) => {
			if (quoted || normalized[i] !== "&") return;
			const prev = normalized[i - 1];
			const next = normalized[i + 1];
			if (prev === "&" || prev === ">") return;
			if (next === "&" || next === ">" || (next >= "0" && next <= "9")) return;
			bg = true;
		});
		if (bg) return false;
	}

	// `$(...)` bodies checked first — before their host segment is split.
	for (const inner of extractSubstitutions(normalized)) {
		if (!isReadOnlyBashCommand(inner, depth + 1)) return false;
	}

	// Flatten compound blocks (`for …; do … done`, `if …; then … fi`) by
	// splitting around their keywords so header and body re-parse as segments.
	// Structural keywords are inert; `for|until|case` headers are inert too
	// (their `$( )` bodies were already checked above). `while|if` headers are
	// real conditions, so they must themselves read as read-only.
	if (/(?<![\w-])(?:for|while|until|if|do|done|then|else|elif|fi|case|esac)\b/.test(normalized)) {
		const parts = splitCommandChain(normalized.replace(/;[ \t]*(do|done|then|fi|else|elif)\b/g, "\n$1"));
		for (const part of parts) {
			const p = part.trim();
			if (!p || /^(?:do|done|then|fi|else|elif|in|esac)$/.test(p)) continue;
			const peeled = p.replace(/^(?:do|then|else|elif|done|fi)\s+/, "");
			const hdr = /^(for|while|until|if|case)\b/.exec(peeled);
			if (hdr) {
				if (hdr[1] === "for" || hdr[1] === "case") continue;
				const cond = peeled.slice(hdr[1].length).trim();
				if (!cond || !isReadOnlyBashCommand(cond, depth + 1)) return false;
				continue;
			}
			if (!isReadOnlyBashCommand(peeled, depth + 1)) return false;
		}
		return true;
	}

	// Bare assignment never touches the filesystem. `name=$(cmd)` and quoted
	// values are safe because the `$( )` body was already verified above.
	const m = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(normalized);
	if (m && m[2]) {
		const v = m[2].trim();
		if (
			(v.startsWith("$(") && v.endsWith(")")) ||
			/^("[^"]*"|'[^']*'|[A-Za-z0-9_./:~=+-]*)$/.test(v)
		)
			return true;
	}

	const segments = splitCommandChain(normalized);
	return segments.length > 0 && segments.every((segment) => isReadOnlyBashSegment(segment));
}

/** Read-only tool names never need a contract; anything else (edit/write/bash
 *  with a state-changing command, etc.) does. `extraReadOnlyTools` extends the
 *  built-in set with third-party read-only tool names (e.g. shepherd_rules).
 *  Only known write tools are always state-changing; unknown tools default to
 *  read-only so the gate never blocks a tool it cannot classify. */
export function isStateChangingTool(
	toolName: string,
	input: Record<string, unknown>,
	extraReadOnlyTools: ReadonlySet<string> = EMPTY_SET,
): boolean {
	if (["read", "grep", "find", "ls", "task_contract", "task_verify", "task_complete"].includes(toolName)) return false;
	if (extraReadOnlyTools.has(toolName)) return false;
	if (["edit", "write", "patch", "bash"].includes(toolName)) {
		if (toolName === "bash") return typeof input.command !== "string" || !isReadOnlyBashCommand(input.command);
		return true;
	}
	return false;
}

const EMPTY_SET: ReadonlySet<string> = new Set();
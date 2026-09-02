// Security Rule 3 - neutralize shell-active syntax in summarizer output.
//
// Everything the store holds is eventually served to a coding AI that writes
// and executes shell commands, so every stored field is treated as if it will
// be pasted into a terminal. Sanitization happens ON WRITE, never on read: the
// store must never hold executable syntax in the first place.
//
// Two policies:
//
//  strip   - display strings (title, summary, pending_items). The
//            metacharacter carries no information there, so removing it
//            loses nothing.
//  escape  - decisions[].what / decisions[].why, pinned notes, digest output.
//            A decision may legitimately need to reference the syntax it
//            ruled out ("rejected `$(date)` in the template"); escaping
//            preserves that, stripping destroys it.
//
// Plus, unconditionally in both: ANSI escape sequences and C0 control
// characters. A decision string ends up printed to a terminal, so
// escape-sequence injection is the same class of bug and costs one regex.
//
// IDEMPOTENCY IS A REQUIREMENT, not a nicety. The backfill re-runs over rows
// that may already be clean, the choke points re-run on every rebuild, and the
// post-backfill verification asserts detectShellSyntax() is false store-wide.
// Every transform below is written so f(f(x)) === f(x), and each has a test.

// Two-character openers escaped by breaking the pair from the inside: `$(` -> `$\(`.
const PAIRED_OPENERS = ['$(', '${', '>(', '<('] as const;

// Heredoc. Escaped the same way (`<<` -> `<\<`), which also defuses `<<<`:
// `<\<<` contains no unescaped `<<` pair.
const HEREDOC = '<<';

// Command chaining is only shell-active at the start of a command, so the test
// is line-leading rather than "anywhere" - a `;` mid-sentence is punctuation
// and mangling it would corrupt ordinary prose. Escaped by PREFIXING a
// backslash to the whole run (`&&` -> `\&&`), never infixing: `&\&` would
// still start the line with `&` and the transform would not be idempotent.
const LINE_LEADING_CHAIN_RE = /^([ \t]*)(\|\||&&|[|;&])/gm;

// CSI (`\x1b[...`), OSC (`\x1b]...` terminated by BEL or ST), and any other
// two-character escape. Matched longest-first so a CSI is never chewed up by
// the catch-all.
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is the entire point of this module
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b][^\x07\x1b]*(?:\x07|\x1b\\)?|\x1b[@-_]?/g;

// C0 controls and DEL, keeping \n and \t: those are legitimate in a summary,
// and \r is not (carriage-return line-overwrite hides text from a reader who
// only sees the rendered terminal output).
// biome-ignore lint/suspicious/noControlCharactersInRegex: neutralizing control characters is the entire point of this module
const CONTROL_RE = /[\x00-\x08\x0b-\x1f\x7f]/g;

// Even backslash parity means the character at `index` remains shell-active.
function precedingBackslashes(s: string, index: number): number {
    let n = 0;
    let i = index - 1;
    while (i >= 0 && s[i] === '\\') {
        n++;
        i--;
    }
    return n;
}

function isActive(s: string, index: number): boolean {
    return precedingBackslashes(s, index) % 2 === 0;
}

function stripControls(s: string): string {
    return s.replace(ANSI_RE, '').replace(CONTROL_RE, '');
}

// Finds the closer matching a paired opener at `openIndex`, honouring nesting,
// or -1 when the text has no closer at all (unbalanced input is common in
// prose and must not throw).
function findMatchingCloser(s: string, openIndex: number, open: string, close: string): number {
    let depth = 0;
    for (let i = openIndex + 1; i < s.length; i++) {
        if (s[i] === open) {
            depth++;
        } else if (s[i] === close) {
            if (depth === 0) {
                return i;
            }
            depth--;
        }
    }
    return -1;
}

// Display-string policy: remove the metacharacter, keep the words.
// `` `foo` `` -> `foo`, `$(date)` -> `date`, `${VAR}` -> `VAR`.
//
// Runs to a fixed point (bounded) because removing one layer can expose
// another: `$($(date))` needs two passes to become `date`.
export function stripShellSyntax(input: string): string {
    let s = stripControls(input);

    for (let pass = 0; pass < 8; pass++) {
        const before = s;

        // Paired openers, innermost-safe: remove the opener and its matching
        // closer together, so the closer is not left orphaned.
        let i = 0;
        while (i < s.length - 1) {
            const two = s.slice(i, i + 2);
            const opener = PAIRED_OPENERS.find((o) => o === two);
            if (!opener) {
                i++;
                continue;
            }
            const close = opener[1] === '(' ? ')' : '}';
            const closeIndex = findMatchingCloser(s, i + 1, opener[1], close);
            s = closeIndex === -1 ? s.slice(0, i) + s.slice(i + 2) : s.slice(0, i) + s.slice(i + 2, closeIndex) + s.slice(closeIndex + 1);
            // Do not advance: the text that shifted into `i` may itself be an opener.
        }

        s = s.split('`').join('');
        s = s.split(HEREDOC).join('');
        s = s.replace(LINE_LEADING_CHAIN_RE, '$1');

        if (s === before) {
            break;
        }
    }
    return s;
}

// Information-preserving policy: break the token with a backslash. The result
// is readable, and inert in both unquoted and double-quoted shell contexts.
// `` ` `` -> `` \` ``, `$(` -> `$\(`, `${` -> `$\{`, `<<` -> `<\<`.
export function escapeShellSyntax(input: string): string {
    let s = stripControls(input);

    // Paired openers and heredoc: infix a backslash. After this the literal
    // two-character token no longer occurs, so a second run is a no-op.
    let out = '';
    for (let i = 0; i < s.length; ) {
        const two = s.slice(i, i + 2);
        if ((PAIRED_OPENERS as readonly string[]).includes(two) || two === HEREDOC) {
            out += `${two[0]}\\${two[1]}`;
            i += 2;
            continue;
        }
        out += s[i];
        i++;
    }
    s = out;

    // Backtick is a single character, so it survives escaping as a literal and
    // needs the parity check to avoid `\\` growing on every pass.
    out = '';
    for (let i = 0; i < s.length; i++) {
        if (s[i] === '`' && isActive(s, i)) {
            out += '\\`';
        } else {
            out += s[i];
        }
    }
    s = out;

    // Only a leading command chain is shell-active in this form.
    s = s.replace(LINE_LEADING_CHAIN_RE, '$1\\$2');

    return s;
}

// True when the text still carries shell-active syntax. Used by the backfill
// preview, by the post-backfill verification, and by the read-time assertion.
//
// Deliberately agrees with both transforms above: anything either of them
// would change (other than pure control-character noise) reports true here,
// and their output reports false. That equivalence is what makes "the store
// never holds executable syntax" a checkable invariant rather than a comment.
export function detectShellSyntax(input: string): boolean {
    if (ANSI_RE.test(input) || CONTROL_RE.test(input)) {
        ANSI_RE.lastIndex = 0;
        CONTROL_RE.lastIndex = 0;
        return true;
    }
    ANSI_RE.lastIndex = 0;
    CONTROL_RE.lastIndex = 0;

    for (let i = 0; i < input.length; i++) {
        if (input[i] === '`' && isActive(input, i)) {
            return true;
        }
        const two = input.slice(i, i + 2);
        if ((PAIRED_OPENERS as readonly string[]).includes(two) || two === HEREDOC) {
            return true;
        }
    }

    LINE_LEADING_CHAIN_RE.lastIndex = 0;
    const hit = LINE_LEADING_CHAIN_RE.test(input);
    LINE_LEADING_CHAIN_RE.lastIndex = 0;
    return hit;
}

// Read-time ASSERTION, not read-time sanitization.
//
// "Sanitization happens on write, never on read" is about where the store
// gets cleaned. It is not an argument for never checking: a store
// invariant that is never verified is documentation drift with extra steps,
// and this codebase has paid for that failure mode repeatedly. A hit here
// means a write path was missed - which is a bug report, not a routine event,
// so it logs loudly and then sanitizes defensively rather than serving
// executable syntax to a model that runs shell commands.
//
// Returns the text to actually serve, and whether it had to be repaired.
export function assertNoShellSyntax(
    text: string,
    context: string,
    log: (msg: string) => void = console.error,
): {
    text: string;
    repaired: boolean;
} {
    if (!detectShellSyntax(text)) {
        return { text, repaired: false };
    }
    log(`[elepha] WARNING: shell-active syntax reached the read path from ${context}; a write-time sanitizer was missed. Repairing.`);
    return { text: escapeShellSyntax(text), repaired: true };
}

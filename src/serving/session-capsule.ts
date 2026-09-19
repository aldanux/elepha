import { randomUUID } from 'node:crypto';
import {
    DURABLE_CAPTURE_FILTER_VERSION,
    FIRST_PROMPT_SEARCH_CAP,
    SESSION_CAPSULE_DECISIONS_CHARS,
    SESSION_CAPSULE_FILES_CHARS,
    SESSION_CAPSULE_MAX_CONTEXT_CHARS,
    SESSION_CAPSULE_MAX_DECISIONS,
    SESSION_CAPSULE_MAX_FILES,
    SESSION_CAPSULE_METADATA_MAX_BYTES,
    SESSION_CAPSULE_PENDING_CHARS,
    SESSION_CAPSULE_SUMMARY_CHARS,
} from '../config/constants.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import { newestDecisions, type RollupDecision } from '../storage/rollup-store.js';
import type { SessionCapsuleMetadata } from '../storage/session-read-model.js';
import { isToolName } from '../types/index.js';
import { dataBlockClose, dataBlockOpen, servedContextInstructions } from './instructions.js';
import { surfaceLabel } from './session-reader.js';

export const CAPSULE_INVALID_SELECTION = 'invalid_selection';
export const CAPSULE_METADATA_BYTE_BUDGET = 'capsule_metadata_byte_budget';
export const CAPSULE_FIXED_METADATA_BUDGET = 'capsule_metadata_exceeds_budget';
export const CAPSULE_OPENING_LABEL = 'Indexed opening document; may already be truncated; outcome unavailable';
export const CAPSULE_EXPANSION =
    'Expansion: use get_session with query for selected historical evidence (rollup, indexed first interaction, then lexical excerpts; a miss is inconclusive), or last_n for a small newest-turn tail, usually 2. Query evidence is limited to 4,000 characters; tails to 80,000 body characters. Never automatically fall back to bare get_session. Historical pending items are not a current agenda.';

interface Section {
    label: string;
    units: string[];
    omitted: number;
    malformed: number;
    reason?: string;
    atomic?: boolean;
}

function parsedArray(value: string | null): { values: unknown[]; malformed: number } {
    if (value === null) {
        return { values: [], malformed: 0 };
    }
    try {
        const values: unknown = JSON.parse(value);
        if (Array.isArray(values)) {
            return { values, malformed: 0 };
        }
    } catch {
        // Report malformed fields without echoing their untrusted contents.
    }
    return { values: [], malformed: 1 };
}

function stringSection(label: string, value: string | null): Section {
    const parsed = parsedArray(value);
    const strings = parsed.values.filter((item): item is string => typeof item === 'string');
    return {
        label,
        units: strings.map((item) => `- ${escapeShellSyntax(item)}`),
        omitted: 0,
        malformed: parsed.malformed + parsed.values.length - strings.length,
        ...(value === null ? { reason: 'not_recorded' } : {}),
    };
}

function decisionSection(value: string | null): Section {
    const parsed = parsedArray(value);
    const decisions: RollupDecision[] = [];
    let malformed = parsed.malformed;
    for (const item of parsed.values) {
        if (!item || typeof item !== 'object' || !('what' in item) || typeof item.what !== 'string') {
            malformed++;
            continue;
        }
        const row = item as Record<string, unknown>;
        const why = row.why == null ? undefined : typeof row.why === 'string' ? row.why : undefined;
        const turnIndex = Number.isSafeInteger(row.turnIndex) && (row.turnIndex as number) >= 0 ? (row.turnIndex as number) : undefined;
        const at = typeof row.at === 'string' ? row.at : undefined;
        if (row.why != null && why === undefined) {
            malformed++;
        }
        if (row.turnIndex != null && turnIndex === undefined) {
            malformed++;
        }
        if (row.at != null && at === undefined) {
            malformed++;
        }
        decisions.push({ what: row.what as string, why, turnIndex, at });
    }
    const chosen = newestDecisions(decisions, SESSION_CAPSULE_MAX_DECISIONS);
    const section: Section = {
        label: 'Decisions',
        units: chosen.map(
            (decision) =>
                `- What: ${escapeShellSyntax(decision.what)}\n  Why: ${decision.why?.trim() ? escapeShellSyntax(decision.why) : 'not recorded'}\n  Stored turn: ${decision.turnIndex ?? 'unknown'}; at: ${escapeShellSyntax(decision.at ?? 'unknown')}`,
        ),
        omitted: decisions.length - chosen.length,
        malformed,
        ...(value === null ? { reason: 'not_recorded' } : {}),
    };
    while (section.units.join('\n').length > SESSION_CAPSULE_DECISIONS_CHARS) {
        section.units.shift();
        section.omitted++;
        section.reason = 'size_budget';
    }
    return section;
}

function omit(section: Section, reason: string): void {
    section.omitted += section.units.length;
    section.units = [];
    section.reason = reason;
}

function renderSection(section: Section): string {
    const noun = section.label === 'Decisions' ? 'decision(s)' : 'item(s)';
    return (
        `${section.label}:\n${section.units.join('\n') || 'No material returned.'}\n` +
        `${section.omitted} ${noun} omitted; ${section.malformed} malformed field(s)/item(s) excluded${section.reason ? `; ${section.reason}` : ''}.`
    );
}

export function capsuleStatus(id: string, reason: string, nonce: string = randomUUID()): string {
    const status = `Session capsule unavailable: ${reason}. No historical material returned.`;
    const identity = `Session: ${escapeShellSyntax(id)}\n`;
    const prefix = `${servedContextInstructions(nonce)}\n\n${dataBlockOpen(nonce)}\n`;
    const suffix = `\n${dataBlockClose(nonce)}`;
    return (
        prefix +
        (prefix.length + identity.length + status.length + suffix.length <= SESSION_CAPSULE_MAX_CONTEXT_CHARS ? identity : '') +
        status +
        suffix
    );
}

export function sessionCapsule(metadata: SessionCapsuleMetadata, id: string, nonce: string = randomUUID()): string {
    if (metadata.metadata_bytes > SESSION_CAPSULE_METADATA_MAX_BYTES) {
        return capsuleStatus(id, CAPSULE_METADATA_BYTE_BUDGET, nonce);
    }
    const value = (field: string | null) => escapeShellSyntax(field ?? 'not recorded');
    const coverage =
        metadata.rollup_state === null
            ? 'no rollup; outcome unavailable'
            : `state ${value(metadata.rollup_state)}; computed ${value(metadata.computed_at)}; through stored turn ${escapeShellSyntax(String(metadata.watermark ?? 'unknown'))}; ${metadata.newer_turn_count} newer stored turn(s); summarizer ${value(metadata.summarizer_status)}`;
    const fixed = [
        `Session: ${escapeShellSyntax(id)}`,
        `Project: ${value(metadata.project_name)}; recorded identity: ${value(metadata.project_key)}`,
        `Title: ${value(metadata.title)}`,
        `Tool/surface: ${isToolName(metadata.tool) ? surfaceLabel(metadata.tool, metadata.surface === 'desktop' ? 'desktop' : null) : value(metadata.tool)}`,
        `Started: ${value(metadata.started_at)}; last recorded activity: ${value(metadata.last_activity)}`,
        `Recorded branch: ${value(metadata.git_branch)}; stored turns: ${metadata.turn_count}`,
        `Summary coverage: ${coverage}.`,
        `Content coverage: durable ${value(metadata.durable_state)}; current filter ${metadata.durable_filter_version === DURABLE_CAPTURE_FILTER_VERSION}; all stored turns have current filtered rows ${metadata.durable_uncovered === 0}. Provider transcript not checked; metadata does not guarantee readable content.`,
        `Incomplete last observation: ${metadata.open_turn_staged_at !== null}; failed ${value(metadata.open_turn_failed_at)}; staged ${value(metadata.open_turn_staged_at)}; receipt coverage ${value(metadata.open_turn_receipt_coverage)}. A failed attempt may be retried or superseded.`,
    ].join('\n');
    const summaryValue = metadata.summary?.trim() ? metadata.summary : metadata.first_prompt_search;
    const summary: Section = {
        label: metadata.summary?.trim() ? 'Historical summary' : CAPSULE_OPENING_LABEL,
        units: summaryValue?.trim() ? [escapeShellSyntax(summaryValue)] : [],
        omitted: 0,
        malformed: 0,
        atomic: true,
        ...(!summaryValue?.trim() ? { reason: 'not_recorded' } : {}),
    };
    if ((summary.units[0]?.length ?? 0) > (metadata.summary?.trim() ? SESSION_CAPSULE_SUMMARY_CHARS : FIRST_PROMPT_SEARCH_CAP)) {
        omit(summary, 'size_budget');
    }
    const decisions = decisionSection(metadata.decisions);
    const pending = stringSection('Historical pending snapshot', metadata.pending_items);
    pending.atomic = true;
    if (pending.units.join('\n').length > SESSION_CAPSULE_PENDING_CHARS) {
        omit(pending, 'size_budget');
    }
    const files = stringSection('Recently recorded files', metadata.trailing_files);
    files.omitted = Math.max(0, files.units.length - SESSION_CAPSULE_MAX_FILES);
    files.units = files.units.slice(0, SESSION_CAPSULE_MAX_FILES);
    while (files.units.join('\n').length > SESSION_CAPSULE_FILES_CHARS) {
        files.units.pop();
        files.omitted++;
        files.reason = 'size_budget';
    }
    const sections = [summary, decisions, pending, files];
    const render = () =>
        `${servedContextInstructions(nonce)}\n\n${dataBlockOpen(nonce)}\n${fixed}\n\n` +
        sections.map(renderSection).join('\n\n') +
        `\n${dataBlockClose(nonce)}\n\n${CAPSULE_EXPANSION}`;
    // Keep identity, provenance and every omission notice. Remove low-priority
    // file references first, then the oldest selected decisions; snapshots are
    // atomic because their item order does not establish chronology.
    for (const section of [files, decisions, summary, pending]) {
        while (render().length > SESSION_CAPSULE_MAX_CONTEXT_CHARS && section.units.length > 0) {
            if (section.atomic) {
                omit(section, 'response_budget');
            } else {
                if (section === files) {
                    section.units.pop();
                } else {
                    section.units.shift();
                }
                section.omitted++;
                section.reason = 'response_budget';
            }
        }
    }
    const text = render();
    return text.length <= SESSION_CAPSULE_MAX_CONTEXT_CHARS ? text : capsuleStatus(id, CAPSULE_FIXED_METADATA_BUDGET, nonce);
}

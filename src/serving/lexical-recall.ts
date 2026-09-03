// Deterministic read-only recall over stored titles, the cached first user
// prompt, session rollups, and the filtered durable copy. No
// transcript-derived value can reach a subprocess from this module.

import { randomUUID } from 'node:crypto';
import {
    REMEMBER_DISTINCTIVE_TOKEN_FRACTION,
    REMEMBER_MATCH_SCORES,
    REMEMBER_MAX_HITS,
    REMEMBER_QUERY_FILLER_WORDS,
    REMEMBER_SCAN_BUDGET_MS,
    REMEMBER_SESSION_RECENCY_CAP,
    SESSION_CHAR_BUDGET,
} from '../config/constants.js';
import type { QueryMatchingMode } from '../config/settings.js';
import { escapeShellSyntax } from '../security/sanitize.js';
import type { ProjectSet } from '../storage/project-resolver.js';
import { relativeTime } from '../util/relative-time.js';
import { DISPLAY_VERBATIM_INSTRUCTIONS, SELECT_HINT, servedContextInstructions } from './instructions.js';
import {
    endedAt,
    hasRealContent,
    type ServedSession,
    type SessionReader,
    type StoredContentCoverage,
    surfaceLabel,
    titleOf,
} from './session-reader.js';

export type RecallScope = 'global' | 'here';

export interface RecallQuery {
    components: string[];
    display: string;
    phrase: string;
    tokens: string[];
}

interface SessionCandidate {
    project: ProjectSet;
    session: ServedSession;
}

interface RecallHit {
    contentBm25?: number;
    project: string;
    sessionTitle: string;
    date: string;
    tool: string;
    matchedTokens: Set<string>;
    tier: number;
    endedAt: string;
    sessionId: number;
}

interface LexicalRecallResult {
    body: string;
    sessionIds: number[];
}

interface Match {
    exactPhrase: boolean;
    tokens: Set<string>;
}

interface PreparedMetadata {
    candidate: SessionCandidate;
    contentBm25?: number;
    contentMatch: Match;
    firstTurnMatch: Match;
    rollupMatch: Match;
    titleMatch: Match;
}

interface RecallRarity {
    distinctiveTokens: Set<string>;
    idfByToken: Map<string, number>;
}

const FILLER_WORDS = new Set<string>(REMEMBER_QUERY_FILLER_WORDS);
export const STRICT_RECALL_FALLBACK_NOTICE = 'No session matched every term; these sessions match some:';

function folded(value: string): string {
    return value
        .normalize('NFKC')
        .replace(/(\p{Lu}+)(\p{Lu}\p{Ll})/gu, '$1 $2')
        .replace(/([\p{Ll}\p{Nd}])(\p{Lu})/gu, '$1 $2')
        .toLowerCase();
}

function componentTokens(value: string): string[] {
    return folded(value).match(/[\p{L}\p{N}]+/gu) ?? [];
}

function lexicalTokens(value: string): string[] {
    const normalized = folded(value);
    const compounds = normalized.match(/[\p{L}\p{N}]+(?:[._/@:+-][\p{L}\p{N}]+)*/gu) ?? [];
    return [...new Set([...compounds, ...componentTokens(normalized)])];
}

function phraseText(value: string): string {
    return componentTokens(value).join(' ');
}

// Returns undefined for empty and filler-only queries, so callers never start a broad scan.
export function tokenizeRecallQuery(value: string): RecallQuery | undefined {
    const display = value.replace(/\s+/g, ' ').trim();
    const components = componentTokens(value).filter((token) => !FILLER_WORDS.has(token));
    if (components.length === 0) {
        return undefined;
    }
    const usefulCompounds = lexicalTokens(value).filter((token) => {
        const parts = componentTokens(token);
        return parts.some((part) => !FILLER_WORDS.has(part));
    });
    const tokens = [...new Set([...usefulCompounds, ...components])];
    return { components, display, phrase: components.join(' '), tokens };
}

function match(texts: Iterable<string>, query: RecallQuery): Match {
    let exactPhrase = false;
    const matched = new Set<string>();
    for (const text of texts) {
        const targetPhrase = phraseText(text);
        const targetTokens = new Set(lexicalTokens(text));
        if (query.phrase.includes(' ') && targetPhrase.includes(query.phrase)) {
            exactPhrase = true;
        }
        for (const token of query.tokens) {
            if (targetTokens.has(token)) {
                matched.add(token);
            }
        }
    }
    return { exactPhrase, tokens: matched };
}

function compareText(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function compareCandidates(a: SessionCandidate, b: SessionCandidate): number {
    return compareText(endedAt(b.session), endedAt(a.session)) || a.session.id - b.session.id;
}

function idfScore(hit: RecallHit, rarity: RecallRarity): number {
    let score = 0;
    for (const token of hit.matchedTokens) {
        score += rarity.idfByToken.get(token) ?? 0;
    }
    return score;
}

function compareHits(a: RecallHit, b: RecallHit, rarity: RecallRarity): number {
    const contentOrder =
        a.tier === REMEMBER_MATCH_SCORES.content && b.tier === REMEMBER_MATCH_SCORES.content
            ? (a.contentBm25 ?? 0) - (b.contentBm25 ?? 0)
            : 0;
    return (
        idfScore(b, rarity) - idfScore(a, rarity) ||
        b.tier - a.tier ||
        contentOrder ||
        compareText(b.endedAt, a.endedAt) ||
        a.sessionId - b.sessionId
    );
}

function startsWithElephaCommand(value: string | null | undefined): boolean {
    return value?.trimStart().toLowerCase().startsWith('elepha:') ?? false;
}

function isRecallCommandSession(session: ServedSession): boolean {
    // The title comes from the first non-command turn, so a real title
    // (or custom title) means substantive work — surface it even if the
    // session opened with an elepha: command (first_prompt_search matches).
    if (hasRealContent(session)) {
        return false;
    }
    // No substantive title: a command-only / content-less session. Exclude it
    // when any signal — title, custom title, or opening prompt — is a command.
    return [session.custom_title, session.title, session.first_prompt_search].some(startsWithElephaCommand);
}

function hitIdentity(candidate: SessionCandidate): Pick<RecallHit, 'project' | 'sessionTitle' | 'date' | 'tool' | 'endedAt' | 'sessionId'> {
    return {
        project: candidate.project.displayName,
        sessionTitle: titleOf(candidate.session),
        date: endedAt(candidate.session).slice(0, 10),
        tool: surfaceLabel(candidate.session.tool, candidate.session.surface),
        endedAt: endedAt(candidate.session),
        sessionId: candidate.session.id,
    };
}

function parsedJsonArray(value: string | null | undefined): unknown[] {
    if (!value?.trim()) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(value);
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function rollupDecisionTexts(value: string | null): string[] {
    return parsedJsonArray(value).flatMap((item) => {
        if (item === null || Array.isArray(item) || typeof item !== 'object') {
            return [];
        }
        const { what, why } = item as Record<string, unknown>;
        return typeof what === 'string' && typeof why === 'string' ? [what, why] : [];
    });
}

function rollupTexts(session: ServedSession): string[] {
    const summary = typeof session.rollup_summary === 'string' && session.rollup_summary.trim() ? [session.rollup_summary] : [];
    const pendingItems = parsedJsonArray(session.rollup_pending_items).filter((item): item is string => typeof item === 'string');
    return [...summary, ...rollupDecisionTexts(session.rollup_decisions), ...pendingItems];
}

function prepareMetadata(candidate: SessionCandidate, query: RecallQuery): PreparedMetadata {
    const session = candidate.session;
    const sessionTitles = [session.title, session.custom_title, session.rollup_title].filter((value): value is string => Boolean(value));
    const titleMatch = match(sessionTitles, query);
    const firstTurnMatch =
        session.first_prompt_search === null
            ? { exactPhrase: false, tokens: new Set<string>() }
            : match([session.first_prompt_search], query);
    const rollupMatch = match(rollupTexts(session), query);
    return { candidate, contentMatch: { exactPhrase: false, tokens: new Set() }, firstTurnMatch, rollupMatch, titleMatch };
}

function prepareRarity(prepared: PreparedMetadata[], query: RecallQuery): RecallRarity {
    const documentFrequency = new Map(query.tokens.map((token) => [token, 0]));
    for (const metadata of prepared) {
        const documentTokens = new Set([
            ...metadata.titleMatch.tokens,
            ...metadata.firstTurnMatch.tokens,
            ...metadata.rollupMatch.tokens,
            ...metadata.contentMatch.tokens,
        ]);
        for (const token of documentTokens) {
            documentFrequency.set(token, (documentFrequency.get(token) ?? 0) + 1);
        }
    }
    const idfByToken = new Map<string, number>();
    const distinctiveTokens = new Set<string>();
    for (const token of query.tokens) {
        const frequency = documentFrequency.get(token) ?? 0;
        idfByToken.set(token, Math.log((prepared.length + 1) / (frequency + 1)) + 1);
        if (prepared.length > 0 && frequency / prepared.length < REMEMBER_DISTINCTIVE_TOKEN_FRACTION) {
            distinctiveTokens.add(token);
        }
    }
    return { distinctiveTokens, idfByToken };
}

function hitForSession(metadata: PreparedMetadata, query: RecallQuery, matchingMode: QueryMatchingMode): RecallHit | undefined {
    const { candidate, contentBm25, contentMatch, firstTurnMatch, rollupMatch, titleMatch } = metadata;
    const matchedTokens = new Set([...titleMatch.tokens, ...firstTurnMatch.tokens, ...rollupMatch.tokens, ...contentMatch.tokens]);
    const matchesQuery =
        matchingMode === 'strict'
            ? query.components.every((token) => matchedTokens.has(token))
            : query.components.some((token) => matchedTokens.has(token));
    if (!matchesQuery) {
        return undefined;
    }
    if (matchedTokens.size === 0) {
        return undefined;
    }
    if (titleMatch.tokens.size > 0) {
        return {
            ...hitIdentity(candidate),
            matchedTokens,
            tier: REMEMBER_MATCH_SCORES.title,
        };
    }
    if (firstTurnMatch.exactPhrase) {
        return {
            ...hitIdentity(candidate),
            matchedTokens,
            tier: REMEMBER_MATCH_SCORES.exactPhrase,
        };
    }
    if (rollupMatch.tokens.size > 0) {
        return {
            ...hitIdentity(candidate),
            matchedTokens,
            tier: REMEMBER_MATCH_SCORES.rollup,
        };
    }
    if (contentMatch.tokens.size > 0) {
        return {
            ...hitIdentity(candidate),
            contentBm25,
            matchedTokens,
            tier: REMEMBER_MATCH_SCORES.content,
        };
    }
    return {
        ...hitIdentity(candidate),
        matchedTokens,
        tier: REMEMBER_MATCH_SCORES.body,
    };
}

function rankAndFloorHits(hits: RecallHit[], rarity: RecallRarity): RecallHit[] {
    const qualifyingHits =
        rarity.distinctiveTokens.size === 0
            ? hits
            : hits.filter((hit) => [...hit.matchedTokens].some((token) => rarity.distinctiveTokens.has(token)));
    const ranked = qualifyingHits.sort((a, b) => compareHits(a, b, rarity));
    return (ranked[0]?.matchedTokens.size ?? 0) >= 2 ? ranked.filter((hit) => hit.matchedTokens.size >= 2) : ranked;
}

function coverageLine(
    reasons: string[],
    searchedProjects: number,
    totalProjects: number,
    searchedSessions: number,
    totalSessions: number,
    contentCoverage: StoredContentCoverage | undefined,
    absenceIsInconclusive: boolean,
): string | undefined {
    if (reasons.length === 0 && (contentCoverage === undefined || contentCoverage.total === 0)) {
        return undefined;
    }
    const partialDurableCopies =
        contentCoverage === undefined ? 0 : contentCoverage.completeTruncated + contentCoverage.incomplete + contentCoverage.neverCaptured;
    const allReasons = [...reasons, partialDurableCopies > 0 ? 'partial durable copies' : undefined].filter(
        (reason): reason is string => reason !== undefined,
    );
    const scanCoverage =
        allReasons.length === 0
            ? undefined
            : `Partial coverage (${allReasons.join(', ')}): searched ${searchedProjects} of ${totalProjects} projects and ${searchedSessions} of ${totalSessions} sessions.`;
    const durableCoverage =
        contentCoverage === undefined || contentCoverage.total === 0
            ? undefined
            : `Content coverage: ${contentCoverage.complete} complete, ${contentCoverage.completeTruncated} complete_truncated, ${contentCoverage.incomplete} incomplete, ${contentCoverage.neverCaptured} never durably captured.`;
    const inconclusive = absenceIsInconclusive && allReasons.length > 0 ? 'Absence is not conclusive.' : undefined;
    return [scanCoverage, durableCoverage, inconclusive].filter((part): part is string => part !== undefined).join(' ');
}

function quotedFtsToken(token: string): string {
    return `"${token.replaceAll('"', '""')}"`;
}

function emptyMessage(query: RecallQuery, scope: RecallScope, project: ProjectSet | undefined): string {
    if (scope === 'global') {
        return `No recall matches found for “${query.display}”.`;
    }
    if (project === undefined) {
        return `The current directory is not a known project. Search every project with elepha:query ${query.display}.`;
    }
    return `No recall matches found for “${query.display}” in ${project.displayName}. Search every project with elepha:query ${query.display}.`;
}

function renderBody(
    query: RecallQuery,
    hits: RecallHit[],
    coverage: string | undefined,
    now: number,
    scope: RecallScope,
    project: ProjectSet | undefined,
    usedLaxFallback: boolean,
): LexicalRecallResult {
    const trailer = coverage === undefined ? ['', SELECT_HINT] : ['', coverage, '', SELECT_HINT];
    if (hits.length === 0) {
        return {
            body: escapeShellSyntax([DISPLAY_VERBATIM_INSTRUCTIONS, emptyMessage(query, scope, project), ...trailer].join('\n')),
            sessionIds: [],
        };
    }

    const nonce = randomUUID();
    const cappedHits = hits.slice(0, REMEMBER_MAX_HITS);
    const resultCapOmitted = hits.length - cappedHits.length;
    const build = (shown: RecallHit[], budgetOmitted: number): string => {
        const lines = [
            servedContextInstructions(nonce),
            DISPLAY_VERBATIM_INSTRUCTIONS,
            '',
            usedLaxFallback ? STRICT_RECALL_FALLBACK_NOTICE : undefined,
            usedLaxFallback ? '' : undefined,
            `Recall hits for “${query.display}” (${shown.length} shown of ${hits.length}):`,
            ...shown.map(
                (hit, index) => `${index + 1}. [${relativeTime(hit.endedAt, now)} | ${hit.tool}] · ${hit.project} · ${hit.sessionTitle}`,
            ),
            resultCapOmitted > 0 ? `+${resultCapOmitted} more matches — refine your query.` : undefined,
            budgetOmitted > 0
                ? `+${budgetOmitted} eligible recall hits omitted by the 20k-token output budget (${shown.length} shown of ${cappedHits.length}).`
                : undefined,
            ...trailer,
        ].filter((line): line is string => line !== undefined);
        return escapeShellSyntax(lines.join('\n'));
    };

    let shown = cappedHits.length;
    let body = build(cappedHits, 0);
    while (body.length > SESSION_CHAR_BUDGET && shown > 0) {
        shown -= 1;
        body = build(cappedHits.slice(0, shown), cappedHits.length - shown);
    }
    return { body, sessionIds: cappedHits.slice(0, shown).map((hit) => hit.sessionId) };
}

// Scans recent metadata plus indexed durable content and returns a fully budgeted injection body.
export async function lexicalRecall(
    reader: SessionReader,
    projects: ProjectSet[],
    query: RecallQuery,
    scope: RecallScope,
    now: (() => number) | undefined,
    relativeNow: number | undefined,
    matchingMode: QueryMatchingMode,
): Promise<LexicalRecallResult> {
    const scanClock = now ?? Date.now;
    const allCandidates = projects
        .flatMap((project) => reader.sessionsFor(project).map((session) => ({ project, session })))
        .filter((candidate) => !isRecallCommandSession(candidate.session))
        .sort(compareCandidates);
    const candidates = allCandidates.slice(0, REMEMBER_SESSION_RECENCY_CAP[scope]);
    const scanStartedAt = scanClock();
    const renderedAt = relativeNow ?? scanStartedAt;
    const prepared: PreparedMetadata[] = [];
    // Matching only tokenizes stored metadata synchronously; there is no I/O to
    // cancel or run concurrently.
    for (const candidate of candidates) {
        if (scanClock() - scanStartedAt > REMEMBER_SCAN_BUDGET_MS) {
            break;
        }
        prepared.push(prepareMetadata(candidate, query));
    }
    const metadataPrepared = [...prepared];
    const contentRecall =
        typeof reader.storedContentRecallFor === 'function'
            ? reader.storedContentRecallFor(
                  allCandidates.map((candidate) => candidate.session),
                  [...new Set(query.components)].map(quotedFtsToken),
                  REMEMBER_SESSION_RECENCY_CAP[scope],
                  () => scanClock() - scanStartedAt <= REMEMBER_SCAN_BUDGET_MS,
              )
            : undefined;
    const preparedBySession = new Map(prepared.map((metadata) => [metadata.candidate.session.id, metadata]));
    if (contentRecall !== undefined) {
        const candidateBySession = new Map(allCandidates.map((candidate) => [candidate.session.id, candidate]));
        for (const [sessionId, content] of contentRecall.matches) {
            const candidate = candidateBySession.get(sessionId);
            if (candidate === undefined) {
                continue;
            }
            const contentMatch = match(content.texts, query);
            if (contentMatch.tokens.size === 0) {
                continue;
            }
            const metadata = preparedBySession.get(sessionId) ?? prepareMetadata(candidate, query);
            metadata.contentBm25 = content.bm25;
            metadata.contentMatch = contentMatch;
            if (!preparedBySession.has(sessionId)) {
                prepared.push(metadata);
                preparedBySession.set(sessionId, metadata);
            }
        }
    }
    const capReached = candidates.length < allCandidates.length;
    const timeBudgetReached = metadataPrepared.length < candidates.length || contentRecall?.timeBudgetReached === true;
    const totalByProject = new Map(projects.map((project) => [project.key, 0]));
    for (const candidate of allCandidates) {
        totalByProject.set(candidate.project.key, (totalByProject.get(candidate.project.key) ?? 0) + 1);
    }
    const searchedByProject = new Map(projects.map((project) => [project.key, 0]));
    let notYetIndexedSessions = 0;
    let searchedSessions = 0;

    for (const metadata of metadataPrepared) {
        const candidate = metadata.candidate;
        if (candidate.session.first_prompt_search === null) {
            notYetIndexedSessions += 1;
            continue;
        }
        searchedSessions += 1;
        searchedByProject.set(candidate.project.key, (searchedByProject.get(candidate.project.key) ?? 0) + 1);
    }
    const searchedProjects = projects.filter(
        (project) => (searchedByProject.get(project.key) ?? 0) === (totalByProject.get(project.key) ?? 0),
    ).length;
    const reasons = [
        capReached ? 'recency cap' : undefined,
        timeBudgetReached ? 'time budget' : undefined,
        contentRecall?.rowCapReached === true ? 'content row cap' : undefined,
        notYetIndexedSessions > 0 ? `${notYetIndexedSessions} not-yet-indexed` : undefined,
    ].filter((reason): reason is string => reason !== undefined);
    const rarity = prepareRarity(prepared, query);
    const matched = prepared.flatMap((metadata) => {
        const hit = hitForSession(metadata, query, matchingMode);
        return hit === undefined ? [] : [hit];
    });
    let hits = rankAndFloorHits(matched, rarity);
    let usedLaxFallback = false;
    if (matchingMode === 'strict' && hits.length === 0) {
        const laxMatches = prepared.flatMap((metadata) => {
            const hit = hitForSession(metadata, query, 'lax');
            return hit === undefined ? [] : [hit];
        });
        hits = rankAndFloorHits(laxMatches, rarity);
        usedLaxFallback = hits.length > 0;
    }
    const coverage = coverageLine(
        reasons,
        searchedProjects,
        projects.length,
        searchedSessions,
        allCandidates.length,
        contentRecall?.coverage,
        hits.length === 0,
    );
    return renderBody(query, hits, coverage, renderedAt, scope, projects[0], usedLaxFallback);
}

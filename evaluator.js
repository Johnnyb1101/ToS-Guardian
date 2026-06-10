// TOS Guardian — Evaluator Agent
// Scores Analyzer output quality before it reaches the UI.

const HEDGE_PHRASES = [
  'not specified', 'not mentioned', 'not found', 'unclear',
  'could not', 'unable to', 'no information', 'not available',
  'not provided', 'not stated', 'not addressed',
  'does not mention', 'does not specify', 'not explicitly'
];

const NOT_COVERED_PHRASES = [
  'not covered in this document',
  'not mentioned',
  'not specified',
  'not addressed',
  'no information',
  'not available'
];

const SECTION_HEADERS = [
  '🔴 DATA SELLING & SHARING',
  '🔴 OPT-OUT RIGHTS',
  '📋 HOW TO OPT OUT RIGHT NOW',
  '🟡 AUTO-RENEWAL & BILLING',
  '🟢 DATA DELETION RIGHTS'
];

const CONTRADICTION_RULES = [
  {
    name: 'sharing-vs-optout',
    sectionA: '🔴 DATA SELLING & SHARING',
    sectionB: '🔴 OPT-OUT RIGHTS',
    negatesA: ['does not share', 'does not sell', 'do not sell', 'do not share', 'no third parties', 'no data sharing', 'no data selling'],
    requiresB: ['opt out of', 'say no to', 'turn off', 'stop sharing', 'stop selling', 'limit sharing', 'restrict'],
    description: 'claims no data sharing but lists sharing opt-outs'
  },
  {
    name: 'optout-vs-howto',
    sectionA: '🔴 OPT-OUT RIGHTS',
    sectionB: '📋 HOW TO OPT OUT RIGHT NOW',
    notCoveredA: true,
    requiresB: ['settings', 'click', 'navigate', 'go to', 'visit', 'contact', 'email', 'call', 'http'],
    description: 'says no opt-out rights but provides opt-out steps'
  },
  {
    name: 'howto-vs-optout',
    sectionA: '📋 HOW TO OPT OUT RIGHT NOW',
    sectionB: '🔴 OPT-OUT RIGHTS',
    notCoveredA: true,
    requiresB: ['opt out', 'say no', 'turn off', 'disable', 'unsubscribe', 'withdraw consent'],
    description: 'says no opt-out steps but lists opt-out rights'
  },
  {
    name: 'deletion-vs-howto',
    sectionA: '🟢 DATA DELETION RIGHTS',
    sectionB: '📋 HOW TO OPT OUT RIGHT NOW',
    negatesA: ['cannot delete', 'no deletion', 'not delete', 'deletion is not available', 'does not offer deletion', 'no right to delete'],
    requiresB: ['delete', 'deletion', 'erase', 'remove your data', 'remove my data'],
    description: 'denies deletion rights but opt-out steps reference deletion'
  }
];

// When a fetch returns navigation chrome instead of the policy text, the model
// frequently says so in prose ("the fetched text is only navigation links, not
// the actual privacy policy") rather than the exact "Not covered" phrasing. That
// is a statement that the DOCUMENT ITSELF wasn't retrieved — it must never score
// as a confident analysis, regardless of how the sections are worded.
const RETRIEVAL_FAILURE_PATTERNS = [
  /\b(fetched|retrieved|provided|document|source)\s+(text|content)\s+(does not|doesn't|only|appears|seems|is only|did not)/i,
  /\bnavigation (links?|menus?|elements?|items?)\b/i,
  /\bnot the actual (privacy|policy|terms|legal|document|content)/i,
  /\bonly (website |site )?navigation\b/i,
  /\bno actual (privacy|policy|terms|legal|document|content)\b/i,
  /\bdocument (content|text) is only\b/i,
  /\bappears to be (a |an )?(navigation|menu|landing|placeholder|error|login)\b/i,
  /\b(could not|couldn't|unable to|failed to) (retrieve|fetch|access|load|read) the (document|policy|terms|page|content)\b/i,
  /\bnot (the )?(actual|real|full) (policy|terms|privacy|document) (text|content|page)\b/i
];

function mentionsRetrievalFailure(text) {
  return RETRIEVAL_FAILURE_PATTERNS.some(pattern => pattern.test(text));
}

const MIN_CREDIBLE_LENGTH = 300;
const ACTIONABLE_PHRASES = [
  'you can', 'call', 'visit', 'go to', 'click', 'turn off',
  'enable', 'unsubscribe', 'submit', 'request', 'contact',
  'email', 'manage', 'opt out', 'say no', 'limit'
];

function parseSections(analysisText) {
  const sections = {};
  const lower = analysisText.toLowerCase();

  for (let i = 0; i < SECTION_HEADERS.length; i++) {
    const header = SECTION_HEADERS[i];
    const start = lower.indexOf(header.toLowerCase());
    if (start === -1) continue;

    const contentStart = start + header.length;
    let end = analysisText.length;
    for (let j = i + 1; j < SECTION_HEADERS.length; j++) {
      const nextPos = lower.indexOf(SECTION_HEADERS[j].toLowerCase(), contentStart);
      if (nextPos !== -1) {
        end = nextPos;
        break;
      }
    }
    sections[header] = analysisText.slice(contentStart, end).trim().toLowerCase();
  }
  return sections;
}

function detectContradictions(analysisText) {
  const sections = parseSections(analysisText);
  const contradictions = [];

  for (const rule of CONTRADICTION_RULES) {
    const textA = sections[rule.sectionA];
    const textB = sections[rule.sectionB];
    if (!textA || !textB) continue;

    let aTriggered = false;

    if (rule.notCoveredA) {
      aTriggered = isSectionUnavailable(textA);
    } else if (rule.negatesA) {
      aTriggered = rule.negatesA.some(p => textA.includes(p));
    }

    if (!aTriggered) continue;

    const bTriggered = rule.requiresB.some(p => textB.includes(p));
    if (!bTriggered) continue;
    if (rule.name === 'optout-vs-howto' && !hasActualOptOutInstruction(textB)) continue;

    contradictions.push({
      rule: rule.name,
      description: rule.description,
      sectionA: rule.sectionA,
      sectionB: rule.sectionB
    });
  }

  return contradictions;
}

function hasActualOptOutInstruction(sectionText) {
  const text = (sectionText || "").toLowerCase();
  const optOutAction = /opt out|unsubscribe|limit|turn off|disable|withdraw consent|global privacy control|do not sell|do not share|delete|request deletion|remove your data/;
  const contactAction = /\b(call|email|contact|submit|request)\b/;
  return optOutAction.test(text) || (contactAction.test(text) && /privacy|data|sharing|marketing|advertising|delete/.test(text));
}

function isSectionUnavailable(sectionText) {
  const text = (sectionText || "").trim().toLowerCase();
  if (!text) return true;

  const hasActionableContent = ACTIONABLE_PHRASES.some(phrase => text.includes(phrase));
  if (hasActionableContent) return false;

  const compact = text
    .replace(/^[-*]\s*/gm, "")
    .replace(/\s+/g, " ")
    .trim();

  return NOT_COVERED_PHRASES.some(phrase => {
    if (compact === phrase) return true;
    return compact.startsWith(`${phrase}.`) || compact.startsWith(`${phrase} —`) || compact.startsWith(`${phrase} -`);
  });
}

function evaluateAnalysis(analysisText, criticVerdict = null) {
  if (!analysisText || typeof analysisText !== 'string') {
    return {
      score: 0,
      label: 'Failed',
      warning: '⚠️ No analysis was returned. The legal document may not have loaded correctly.',
      issues: ['no analysis returned'],
      passed: false,
      escalate: true,
      contradictions: [],
      criticVerdict: null
    };
  }

  const text = analysisText.toLowerCase();
  let score = 100;
  const issues = [];

  // Check 1: Is the response long enough to be credible?
  if (analysisText.length < MIN_CREDIBLE_LENGTH) {
    score -= 40;
    issues.push('response too short');
  }

  // Check 2: How many hedge phrases appear?
  let hedgeCount = 0;
  for (const phrase of HEDGE_PHRASES) {
    if (text.includes(phrase)) hedgeCount++;
  }
  const hedgeDensity = hedgeCount / Math.max(1, analysisText.length / 100);
  if (hedgeDensity > 1.5) {
    score -= 25;
    issues.push('high hedge density — content may not have been retrieved');
  } else if (hedgeDensity > 0.8) {
    score -= 10;
    issues.push('moderate hedge phrases detected');
  }

  // Check 3: Did any upstream fetch errors bleed into the output?
  const errorPatterns = ['fetch failed', 'error:', '[error]', 'timed out', 'could not fetch'];
  for (const pattern of errorPatterns) {
    if (text.includes(pattern)) {
      score -= 20;
      issues.push('upstream fetch error detected in output');
      break;
    }
  }

  // Check 4: All sections empty — document likely failed to fetch
  const sections = parseSections(analysisText);
  const sectionValues = Object.values(sections);
  if (sectionValues.length > 0) {
    const emptyCount = sectionValues.filter(s => isSectionUnavailable(s)).length;
    if (emptyCount >= sectionValues.length) {
      score -= 50;
      issues.push('all sections empty — document likely not retrieved');
    } else if (emptyCount >= sectionValues.length - 1) {
      score -= 20;
      issues.push('nearly all sections empty');
    }
  }

  const corePrivacySections = [
    sections[SECTION_HEADERS[0]],
    sections[SECTION_HEADERS[1]],
    sections[SECTION_HEADERS[4]]
  ];
  if (corePrivacySections.every(isSectionUnavailable)) {
    score -= 30;
    issues.push('core privacy sections empty');
  }

  // Check 5: Cross-section contradiction detection
  const contradictions = detectContradictions(analysisText);
  if (contradictions.length > 0) {
    score -= 15 * contradictions.length;
    for (const c of contradictions) {
      issues.push(`contradiction: ${c.description}`);
      console.warn(`[Evaluator] Contradiction — ${c.rule}: ${c.description} (${c.sectionA} vs ${c.sectionB})`);
    }
  }

  // Check 6: Critic/Judge verdicts — penalize unsupported or vague sections
  if (criticVerdict) {
    const criticFields = ['dataSelling', 'optOutRights', 'howToOptOut', 'autoRenewal', 'dataDeletion'];
    for (const field of criticFields) {
      if (criticVerdict[field] === 'unsupported') {
        score -= 20;
        issues.push(`critic: ${field} unsupported by source`);
      } else if (criticVerdict[field] === 'vague') {
        score -= 10;
        issues.push(`critic: ${field} too vague`);
      }
    }
  }

  // Check 7: Did the analyzer report that the document itself wasn't retrieved?
  // This is the strongest possible "not a real analysis" signal — apply a penalty
  // large enough to force Failed even from an otherwise-perfect-looking score, so
  // navigation-chrome results can never be presented as Strong.
  const retrievalFailure = mentionsRetrievalFailure(analysisText);
  if (retrievalFailure) {
    score -= 70;
    issues.push('analysis reports the document was not retrieved');
  }

  score = Math.max(0, Math.min(100, score));

  // Thresholds per ESCALATION-001
  // Strong = 95+, Adequate = 75-94, Failed = below 75
  let label;
  if (score >= 95)      label = 'Strong';
  else if (score >= 75) label = 'Adequate';
  else                  label = 'Failed';

  let warning = null;
  if (retrievalFailure) {
    warning = '⚠️ The legal document could not be retrieved — the page returned navigation or placeholder content instead of the policy text. This summary is not reliable; open the document directly before agreeing.';
  } else if (label === 'Failed') {
    warning = '⚠️ Analysis quality could not be verified. Some claims may be unsupported or incomplete, so review the source documents before relying on this summary.';
  } else if (label === 'Adequate') {
    warning = '⚠️ Partial analysis — some sections could not be fully assessed. Use this as a starting point, not a complete review.';
  }

  // escalate flag — read by Orchestrator to trigger Opus retry (ESCALATION-002)
  // Failed always escalates. Adequate escalates unless session cap is hit.
  const escalate = label === 'Failed' || label === 'Adequate';
  const passed = label === 'Strong' || label === 'Adequate';

  console.log(`[Evaluator] Score: ${score} | Label: ${label} | Contradictions: ${contradictions.length} | Critic: ${criticVerdict ? 'yes' : 'skipped'} | Issues: ${issues.join(', ') || 'none'}`);

  return { score, label, warning, issues, passed, escalate, contradictions, criticVerdict };
}

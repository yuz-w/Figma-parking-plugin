// ===================================================
// 주차 UX 라이팅 체커 - Figma Plugin
// 내비+T주차 화면의 UX 라이팅 & 줄바꿈 규칙을 검사합니다
// ===================================================

figma.showUI(__html__, { width: 440, height: 600, title: '주차 UX 라이팅 체커' });

figma.ui.onmessage = function (msg) {
  if (msg.type === 'run-check') {
    try {
      var results = runChecks();
      figma.ui.postMessage({ type: 'results', data: results });
    } catch (e) {
      figma.ui.postMessage({ type: 'error', message: '검사 중 오류가 발생했습니다: ' + String(e) });
    }
  }
  if (msg.type === 'navigate') {
    try {
      var node = figma.getNodeById(msg.nodeId);
      if (node) {
        figma.viewport.scrollAndZoomIntoView([node]);
        figma.currentPage.selection = [node];
      }
    } catch (e) {}
  }
};

// ============================================
// 규칙 설정
// ============================================
var RULES_CONFIG = {
  forbiddenEndings: ['합니다', '입니다', '었습니다', '겠습니다', '습니다', '하십시오', '바랍니다'],
  haeyoRequiredPatterns: ['suggest', 'badge', 'search_bar', 'placeholder', 'recommend', 'tip'],
  forbiddenWords: [
    // ── PC/마우스 전용 표현 ──
    { word: '클릭',         suggest: '"선택" 또는 "확인"으로 바꿔주세요 (클릭은 PC/마우스 전용 표현)' },
    { word: '터치하세요',   suggest: '"선택해주세요"로 바꿔주세요' },
    { word: '탭해주세요',   suggest: '"선택해주세요"로 바꿔주세요' },
    { word: '탭하세요',     suggest: '"선택해주세요"로 바꿔주세요' },
    { word: '눌러주세요',   suggest: '"선택해주세요" 또는 "확인해주세요"로 바꿔주세요' },
    { word: '스크롤하세요', suggest: '"아래로 내려보세요"로 바꿔주세요' },

    // ── 반말 / 어색한 어미 ──
    { word: '인가?',   suggest: '반말 표현입니다. "인가요?" 또는 "인지 확인해주세요" 형식으로 바꿔주세요' },
    { word: '이야.',   suggest: '반말 표현입니다. 해요체로 바꿔주세요' },
    { word: '이야!',   suggest: '반말 표현입니다. 해요체로 바꿔주세요' },
    { word: '야!',     suggest: '반말 표현입니다. 해요체로 바꿔주세요' },
    { word: '하지.',   suggest: '반말 표현입니다. 해요체로 바꿔주세요' },
    { word: '해봐.',   suggest: '반말 표현입니다. "해보세요"로 바꿔주세요' },
    { word: '해봐요',  suggest: '어색한 표현입니다. "해보세요"로 바꿔주세요' },

    // ── 추측성 문구 ──
    { word: '것 같아요',    suggest: '추측성 표현입니다. 확실한 정보를 명확하게 전달해주세요 (예: "~예요", "~입니다")' },
    { word: '것 같습니다',  suggest: '추측성 표현입니다. 확실한 정보를 명확하게 전달해주세요' },
    { word: '것 같아',      suggest: '추측성 반말 표현입니다. 명확한 해요체로 바꿔주세요' },
    { word: '같기도 해',    suggest: '추측성 표현입니다. 명확한 정보로 바꿔주세요' },
    { word: '인 것 같',     suggest: '추측성 표현입니다. "이에요", "입니다"로 바꿔주세요' },
    { word: '일 수도 있',   suggest: '추측성 표현입니다. 확실한 정보를 전달하거나 문구를 삭제해주세요' },
    { word: '아닐까요',     suggest: '추측성 표현입니다. 명확한 안내 문구로 바꿔주세요' },
    { word: '일지도 몰',    suggest: '추측성 표현입니다. 확실한 정보로 바꿔주세요' },
    { word: '인 듯해',      suggest: '추측성 표현입니다. "이에요", "입니다"로 바꿔주세요' },
    { word: '인 듯합',      suggest: '추측성 표현입니다. "입니다"로 바꿔주세요' },
    { word: '일 수 있어',   suggest: '추측성 표현입니다. 확실한 정보로 바꾸거나 삭제해주세요' },
    { word: '일 수 있습',   suggest: '추측성 표현입니다. 확실한 정보로 바꾸거나 삭제해주세요' },
  ],
  singleLinePatterns: ['suggest', 'badge', 'pin_parking', 'pin_', 'price', 'walk', 'tab', 'bt_', 'cta', '더보기', 'chip', 'label', 'filter'],
  pricePattern: /^[\d,]+원$/,
  maxLengths: [
    { patterns: ['suggest', 'badge'], max: 22, label: '추천 배지' },
    { patterns: ['tab', 'tabmenu'],   max: 8,  label: '탭 라벨' },
    { patterns: ['chip', 'filter', 'bt_filter'], max: 12, label: '필터 버튼' },
    { patterns: ['bt_sort'], max: 12, label: '정렬 버튼' },
  ],
  parkingNameMax: 15,
};

// ============================================
// 메인 검사 함수
// ============================================
function runChecks() {
  var textNodes = [];

  var selection = figma.currentPage.selection;
  if (!selection || selection.length === 0) return { error: '피그마에서 검사할 프레임을 먼저 선택해주세요.' };
  textNodes = getAllTextNodes(selection);

  if (textNodes.length === 0) return { error: '검사할 텍스트를 찾을 수 없어요.' };

  var issues  = [];
  var scanLog = [];   // ← 전체 검사 내역

  for (var i = 0; i < textNodes.length; i++) {
    var node = textNodes[i];
    var text = node.characters;
    if (!text || text.trim() === '') continue;

    var ctx = getNodeContext(node);
    var shortText = text.length > 40 ? text.substring(0, 40) + '…' : text;

    var nodeLog = {
      nodeId:      node.id,
      nodeName:    node.name,
      text:        shortText,
      path:        ctx.path,
      ruleResults: [],
      hasIssue:    false,
    };

    var checks = [
      checkSpeechLevel(node, text, ctx),
      checkLineBreak(node, text, ctx),
      checkPriceFormat(node, text, ctx),
      checkForbiddenWords(node, text, ctx),
      checkTextLength(node, text, ctx),
    ];

    for (var j = 0; j < checks.length; j++) {
      var c = checks[j];
      if (c.issue) { issues.push(c.issue); nodeLog.hasIssue = true; }
      nodeLog.ruleResults.push(c.log);
    }

    scanLog.push(nodeLog);
  }

  return { issues: issues, totalNodes: textNodes.length, scanLog: scanLog };
}

// ============================================
// 헬퍼
// ============================================
function getAllTextNodes(nodes) {
  var result = [];
  for (var i = 0; i < nodes.length; i++) {
    var node = nodes[i];
    if (node.visible === false) continue;
    if (node.type === 'TEXT') { result.push(node); }
    else if (node.children) {
      var sub = getAllTextNodes(node.children);
      for (var j = 0; j < sub.length; j++) result.push(sub[j]);
    }
  }
  return result;
}

function getNodeContext(node) {
  var names = [];
  var pathParts = [];
  var curr = node;
  var depth = 0;
  while (curr && curr.type !== 'PAGE' && depth < 6) {
    var n = (curr.name || '').toLowerCase();
    names.push(n);
    if (depth > 0 && curr.name) pathParts.unshift(curr.name);
    curr = curr.parent;
    depth++;
  }
  return { allNames: names.join(' '), path: pathParts.join(' > ') };
}

// 결과 헬퍼
function mkSkip(ruleName, reason) {
  return { issue: null, log: { ruleName: ruleName, result: 'skipped', reason: reason } };
}
function mkPass(ruleName, reason) {
  return { issue: null, log: { ruleName: ruleName, result: 'passed', reason: reason } };
}
function mkIssue(ruleId, ruleName, severity, node, text, ctx, message) {
  var display = text.length > 50 ? text.substring(0, 50) + '…' : text;
  return {
    issue: { ruleId: ruleId, ruleName: ruleName, severity: severity,
             nodeId: node.id, nodeName: node.name, text: display, path: ctx.path, message: message },
    log:   { ruleName: ruleName, result: 'issue', reason: message },
  };
}

// ============================================
// 검사 1: 어미 일관성
// 배지·추천문구·검색창처럼 친근한 톤이 필요한 요소에서만 해요체를 체크합니다.
// 시스템 안내·정보 전달 텍스트는 합쇼체(~니다)도 허용합니다.
// ============================================
function checkSpeechLevel(node, text, ctx) {
  var R = '어미 일관성';
  if (text.length < 4)                           return mkSkip(R, '4글자 미만 → 건너뜀');
  if (/^[\d,원m%·\s]+$/.test(text))             return mkSkip(R, '숫자/단위만 있음 → 건너뜀');
  if (/^[A-Za-z0-9\s]+$/.test(text))            return mkSkip(R, '영문/숫자만 있음 → 건너뜀');
  if (/^\d/.test(text) && text.length <= 6)      return mkSkip(R, '짧은 숫자 텍스트 → 건너뜀');

  var requiresHaeyo = RULES_CONFIG.haeyoRequiredPatterns.some(function (p) {
    return ctx.allNames.indexOf(p) !== -1;
  });
  if (!requiresHaeyo) {
    return mkSkip(R, '해요체 필수 요소 아님 (레이어: "' + node.name + '") → 합쇼체 허용');
  }

  for (var i = 0; i < RULES_CONFIG.forbiddenEndings.length; i++) {
    var e = RULES_CONFIG.forbiddenEndings[i];
    if (text.endsWith(e)) {
      return mkIssue('speech_level', R, 'warning', node, text, ctx,
        '추천 배지·검색창에는 해요체("~해요", "~좋아요")가 적합합니다.');
    }
  }
  return mkPass(R, '해요체 또는 명사형 종결 확인됨');
}

// ============================================
// 검사 2: 줄바꿈 규칙
// ============================================
function checkLineBreak(node, text, ctx) {
  var R = '줄바꿈 규칙';
  var hasManualBreak = text.indexOf('\n') !== -1;

  if (hasManualBreak) {
    var strictPatterns = ['badge', 'suggest', 'pin', 'price', 'walk', 'bt_', 'tab', '더보기', 'chip', 'filter'];
    var isStrict = strictPatterns.some(function (p) { return ctx.allNames.indexOf(p) !== -1; });
    if (isStrict) {
      return mkIssue('line_break', R, 'error', node, text.replace(/\n/g, ' ↵ '), ctx,
        '배지·가격·버튼 등 이 요소는 줄바꿈이 있으면 안 됩니다. 엔터(↵)를 제거해주세요.');
    }
    return mkIssue('line_break', R, 'warning', node, text.replace(/\n/g, ' ↵ '), ctx,
      '수동 줄바꿈(엔터)이 포함되어 있습니다. 의도한 줄바꿈인지 확인해주세요.');
  }

  var fontSize = (typeof node.fontSize === 'number') ? node.fontSize : 14;
  var isMultiLine = node.height > fontSize * 1.6 * 1.4;
  if (isMultiLine) {
    var slPatterns = ['suggest', 'badge', 'pin_parking', 'tab', 'walk', 'chip'];
    var needsSingle = slPatterns.some(function (p) { return ctx.allNames.indexOf(p) !== -1; });
    if (needsSingle) {
      var lineCount = Math.max(2, Math.round(node.height / (fontSize * 1.45)));
      return mkIssue('line_break', R, 'warning', node, text, ctx,
        '이 요소는 1줄이어야 합니다. 현재 약 ' + lineCount + '줄로 표시될 수 있어요.');
    }
    return mkPass(R, '여러 줄 허용 요소 (높이 ' + Math.round(node.height) + 'px) → 통과');
  }
  return mkPass(R, '수동 줄바꿈 없음, 1줄로 표시됨');
}

// ============================================
// 검사 3: 가격 형식 (N,NNN원)
// ============================================
function checkPriceFormat(node, text, ctx) {
  var R = '가격 형식';
  if (!text.endsWith('원'))                        return mkSkip(R, '"원"으로 끝나지 않음 → 건너뜀');
  if (text.length > 12)                            return mkSkip(R, '12글자 초과 (문장 내 "원" 추정) → 건너뜀');
  if (!/\d/.test(text))                            return mkSkip(R, '숫자 없음 → 건너뜀');
  if (!RULES_CONFIG.pricePattern.test(text))       return mkSkip(R, '숫자+콤마+원 형식이 아님 → 건너뜀');

  var rawNum = parseInt(text.replace('원', '').replace(/,/g, ''), 10);
  if (isNaN(rawNum) || rawNum < 1000)              return mkPass(R, '1,000원 미만이라 콤마 불필요 → 통과');

  if (text.replace('원', '').indexOf(',') === -1) {
    var correct = formatNumber(rawNum) + '원';
    return mkIssue('price_format', R, 'error', node, text, ctx,
      '천단위 콤마가 빠졌습니다. "' + correct + '" 형식으로 수정해주세요.');
  }
  var expected = formatNumber(rawNum) + '원';
  if (text !== expected) {
    return mkIssue('price_format', R, 'error', node, text, ctx,
      '가격 형식이 맞지 않습니다. "' + expected + '" 형식으로 수정해주세요.');
  }
  return mkPass(R, '"' + text + '" → N,NNN원 형식 올바름');
}

// ============================================
// 검사 4: 금지 표현
// ============================================
function checkForbiddenWords(node, text, ctx) {
  var R = '금지 표현';
  var normalizedText = text.replace(/\s/g, '');
  for (var i = 0; i < RULES_CONFIG.forbiddenWords.length; i++) {
    var item = RULES_CONFIG.forbiddenWords[i];
    var normalizedWord = item.word.replace(/\s/g, '');
    if (text.indexOf(item.word) !== -1 || normalizedText.indexOf(normalizedWord) !== -1) {
      return mkIssue('forbidden_words', R, 'error', node, text, ctx,
        '"' + item.word + '" 사용 감지. ' + item.suggest);
    }
  }
  return mkPass(R, '금지 단어 없음 → 통과');
}

// ============================================
// 검사 5: 텍스트 길이
// ============================================
function checkTextLength(node, text, ctx) {
  var R = '텍스트 길이';
  for (var i = 0; i < RULES_CONFIG.maxLengths.length; i++) {
    var rule = RULES_CONFIG.maxLengths[i];
    var matched = rule.patterns.some(function (p) { return ctx.allNames.indexOf(p) !== -1; });
    if (matched) {
      if (text.length > rule.max) {
        return mkIssue('text_length', R, 'warning', node, text, ctx,
          rule.label + ' 텍스트가 ' + text.length + '자입니다. ' + rule.max + '자 이내를 권장합니다.');
      }
      return mkPass(R, rule.label + ' ' + text.length + '자 (' + rule.max + '자 이내) → 통과');
    }
  }
  if (text.endsWith('주차장')) {
    if (text.length > RULES_CONFIG.parkingNameMax) {
      return mkIssue('text_length', R, 'warning', node, text, ctx,
        '주차장 이름이 ' + text.length + '자입니다. ' + RULES_CONFIG.parkingNameMax + '자 이내를 권장합니다.');
    }
    return mkPass(R, '주차장명 ' + text.length + '자 (' + RULES_CONFIG.parkingNameMax + '자 이내) → 통과');
  }
  return mkSkip(R, '길이 제한 대상 레이어 아님 (레이어: "' + node.name + '") → 건너뜀');
}

// ============================================
// 숫자 포맷
// ============================================
function formatNumber(num) {
  var s = String(num), r = '';
  for (var i = 0; i < s.length; i++) {
    if (i > 0 && (s.length - i) % 3 === 0) r += ',';
    r += s[i];
  }
  return r;
}

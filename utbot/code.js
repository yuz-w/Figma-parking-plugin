// ══════════════════════════════════════════════════════════════════
// [1] 유틸 함수
// ══════════════════════════════════════════════════════════════════

/** sRGB 상대 휘도 (Figma 0-1 기준) */
function relativeLuminance(r, g, b) {
  const toLinear = c => c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  return 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
}

/** WCAG 대비율 */
function contrastRatio(c1, c2) {
  const l1 = relativeLuminance(c1.r, c1.g, c1.b);
  const l2 = relativeLuminance(c2.r, c2.g, c2.b);
  const lighter = Math.max(l1, l2);
  const darker  = Math.min(l1, l2);
  return (lighter + 0.05) / (darker + 0.05);
}

/** Figma fill에서 solid 색상 추출. 없으면 null */
function getSolidFill(fills) {
  if (!fills || fills.length === 0) return null;
  const solid = fills.find(f => f.type === 'SOLID' && f.visible !== false);
  return solid ? solid.color : null;
}

/** 노드 트리 전체 순회 (DFS) */
function* walkTree(node) {
  yield node;
  if ('children' in node) {
    for (const child of node.children) yield* walkTree(child);
  }
}

/** 4px 그리드 정렬 여부 */
function isGridAligned(val) {
  return Math.round(val) % 4 === 0;
}

// ══════════════════════════════════════════════════════════════════
// [2] 규칙 기반 스캐너
// ══════════════════════════════════════════════════════════════════

/**
 * 프레임 노드를 순회하며 7가지 규칙을 체크.
 * @returns {Array<{rule, severity, message, nodeId}>}
 */
function scanRules(frameNode) {
  const findings = [];
  const warn = (rule, message, nodeId) =>
    findings.push({ rule, severity: 'warn', message, nodeId: nodeId || null });
  const fail = (rule, message, nodeId) =>
    findings.push({ rule, severity: 'fail', message, nodeId: nodeId || null });

  const fontSizes = new Set();
  let totalNodes = 0;
  let misalignedCount = 0;
  const componentMap = {};

  for (const node of walkTree(frameNode)) {
    if (node.id === frameNode.id) continue;
    totalNodes++;

    // 규칙 1: 소형 텍스트
    if (node.type === 'TEXT') {
      const size = typeof node.fontSize === 'number' ? node.fontSize : 12;
      fontSizes.add(size);
      if (size < 12) {
        warn('small-text',
          `텍스트 "${(node.characters || '').slice(0, 20)}" 크기 ${size}px (12px 미만)`,
          node.id);
      }

      // 규칙 2: 색상 대비
      const textColor = getSolidFill(node.fills);
      if (textColor && node.parent) {
        const bgColor = getSolidFill(node.parent.fills);
        if (bgColor) {
          const ratio = contrastRatio(textColor, bgColor);
          if (ratio < 4.5) {
            fail('contrast',
              `텍스트 "${(node.characters || '').slice(0, 20)}" 대비율 ${ratio.toFixed(1)}:1 (WCAG AA 4.5:1 미만)`,
              node.id);
          }
        }
      }
    }

    // 규칙 3: 터치 타겟 크기
    if (node.type === 'INSTANCE' || node.type === 'COMPONENT') {
      const name = node.name.toLowerCase();
      const isInteractive = name.includes('button') || name.includes('btn') ||
        name.includes('tab') || name.includes('chip') || name.includes('icon');
      if (isInteractive) {
        const w = 'width' in node ? node.width : 0;
        const h = 'height' in node ? node.height : 0;
        if (w < 44 || h < 44) {
          warn('touch-target',
            `"${node.name}" 터치 타겟 ${Math.round(w)}×${Math.round(h)}px (44px 미만)`,
            node.id);
        }
      }
    }

    // 규칙 4: 아이콘 전용 버튼
    if (node.type === 'INSTANCE') {
      const name = node.name.toLowerCase();
      const isBtn = name.includes('button') || name.includes('btn') || name.includes('icon-btn');
      if (isBtn) {
        const hasText = 'children' in node &&
          [...walkTree(node)].some(n => n.id !== node.id && n.type === 'TEXT' && (n.characters || '').trim());
        if (!hasText) {
          warn('icon-only-button', `"${node.name}" 텍스트 레이블 없는 버튼`, node.id);
        }
      }
    }

    // 규칙 6: 여백 일관성 (4px 그리드)
    if ('x' in node && 'y' in node && node.type !== 'TEXT') {
      if (!isGridAligned(node.x) || !isGridAligned(node.y)) {
        misalignedCount++;
      }
    }

    // 규칙 7: 컴포넌트 일관성
    if (node.type === 'INSTANCE' && node.mainComponent) {
      const cid = node.mainComponent.id;
      if (!componentMap[cid]) componentMap[cid] = [];
      componentMap[cid].push({
        w: Math.round(node.width),
        h: Math.round(node.height),
        name: node.name,
        id: node.id,
      });
    }
  }

  // 규칙 5: 텍스트 계층 구조
  if (fontSizes.size > 4) {
    warn('text-hierarchy',
      `폰트 크기 ${fontSizes.size}가지 사용 (4가지 초과 — 텍스트 계층 불명확)`);
  }

  // 규칙 6 집계
  if (totalNodes > 0) {
    const ratio = misalignedCount / totalNodes;
    if (ratio > 0.1) {
      warn('grid-alignment',
        `전체 노드 중 ${Math.round(ratio * 100)}%가 4px 그리드 미정렬`);
    }
  }

  // 규칙 7 집계
  for (const instances of Object.values(componentMap)) {
    if (instances.length < 2) continue;
    const sizes = new Set(instances.map(i => `${i.w}x${i.h}`));
    if (sizes.size > 1) {
      warn('component-consistency',
        `"${instances[0].name}" 컴포넌트가 ${sizes.size}가지 다른 크기로 사용됨 (${[...sizes].join(', ')})`);
    }
  }

  return findings;
}

// ══════════════════════════════════════════════════════════════════
// [3] Claude API 호출
// ══════════════════════════════════════════════════════════════════

async function callClaude(apiKey, base64png, findings, frameName) {
  const failCount = findings.filter(f => f.severity === 'fail').length;
  const warnCount = findings.filter(f => f.severity === 'warn').length;
  const findingsSummary = findings.map(f =>
    `[${f.severity === 'fail' ? '실패' : '경고'}] ${f.rule}: ${f.message}`
  ).join('\n') || '자동 감지된 문제 없음';

  const system = `당신은 15년 경력의 시니어 UX/UI 디자이너이자 리서처입니다. 다음 전문 지식을 보유하고 있습니다.

[보유 전문 지식]
1. Nielsen Norman Group 10가지 사용성 휴리스틱
2. 게슈탈트(Gestalt) 심리학 원칙 — 근접성, 유사성, 연속성, 폐쇄성, 전경-배경 분리
3. Fitts의 법칙 — 클릭/터치 타겟 크기와 거리의 관계
4. Hick의 법칙 — 선택지 수와 의사결정 시간의 관계, 인지 과부하
5. Miller의 법칙 — 작업 기억 용량(7±2), 청킹(chunking) 전략
6. Don Norman의 행동 유도성(Affordance)과 시그니파이어(Signifier) 이론
7. 시각적 계층 구조 — 크기, 색상 대비, 여백, 폰트 웨이트를 통한 정보 우선순위
8. 색채 심리학 — 색상이 감정과 행동에 미치는 영향, 브랜드 일관성
9. 타이포그래피 가독성 — 행간, 자간, 줄 길이, 폰트 선택
10. 점진적 공개(Progressive Disclosure) — 복잡성 관리 전략
11. 감성 디자인(Emotional Design) — Don Norman의 본능적/행동적/반성적 3단계
12. 정보 구조(Information Architecture) — 카드 소팅, 트리 테스팅, 메뉴 구조
13. 마이크로인터랙션 — 피드백, 트리거, 규칙, 루프의 설계
14. 접근성(Accessibility) — WCAG 2.1 AA 기준, 포용적 디자인 원칙
15. 모바일 UX 패턴 — 엄지 존(Thumb Zone), 제스처 내비게이션, 터치 인터페이스

분석 시 위 지식을 통합적으로 적용하고, 발견한 문제에 가장 적합한 프레임워크를 선택하여 근거를 제시하세요. 모든 분석은 한국어로 작성합니다.`;

  const prompt = `아래 Figma 프레임 "${frameName}"의 스크린샷과 자동 규칙 검사 결과를 분석하세요.

[자동 규칙 검사 결과]
실패: ${failCount}건, 경고: ${warnCount}건
${findingsSummary}

반드시 아래 JSON 형식으로만 응답하세요. JSON 외 다른 텍스트는 절대 포함하지 마세요.

{
  "insights": [
    {
      "content": "인사이트 내용 (한 문장)",
      "description": "상세 설명 — 왜 문제인지, 사용자에게 어떤 영향을 주는지",
      "framework": "적용한 UX 프레임워크 또는 원칙 이름"
    }
  ],
  "기능인지": "주요 기능의 인지 가능성 분석 (Affordance, 시각 계층, 게슈탈트 관점)",
  "과업흐름": "목표 달성 흐름 분석 (Hick의 법칙, 점진적 공개, 인지 부하 관점)",
  "탐색유도": "내비게이션 및 탐색 경험 분석 (정보 구조, Nielsen 휴리스틱 관점)",
  "오류방지": "오류 방지 및 복구 경험 분석 (Nielsen 오류 방지 휴리스틱, 피드백 관점)",
  "시각디자인": "시각적 계층, 색채, 타이포그래피, 여백의 완성도 분석",
  "감성경험": "브랜드 일관성, 감성 디자인, 마이크로인터랙션 관점 분석",
  "접근성": "색상 대비, 텍스트 가독성, 터치 타겟, 포용적 디자인 관점 분석",
  "개선아이디어": "우선순위 높은 개선 제안 2-3가지 (각 제안에 근거 프레임워크 명시)",
  "scores": {
    "기능인지": 3,
    "과업흐름": 3,
    "탐색유도": 3,
    "오류방지": 3,
    "시각디자인": 3,
    "감성경험": 3,
    "접근성": 3,
    "전체사용성": 3
  },
  "총평": "전체 UX/UI 품질 총평 (강점과 핵심 개선 방향 포함, 3-4문장)"
}`;

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-4-6',
      max_tokens: 3000,
      system,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/png', data: base64png },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  if (!res.ok) {
    const errBody = await res.text();
    if (res.status === 401) throw new Error('API 키가 올바르지 않습니다.');
    if (res.status === 429) throw new Error('API 요청 한도 초과. 잠시 후 다시 시도해주세요.');
    throw new Error(`Claude API 오류 (${res.status}): ${errBody.slice(0, 100)}`);
  }

  const data = await res.json();
  const text = data.content?.[0]?.text || '';
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Claude 응답을 파싱할 수 없습니다.');
  return JSON.parse(jsonMatch[0]);
}

// ══════════════════════════════════════════════════════════════════
// [4] 리포트 프레임 빌더
// ══════════════════════════════════════════════════════════════════

const REPORT_WIDTH = 600;
const COLORS = {
  bg:      { r: 1,    g: 1,    b: 1    },
  title:   { r: 0.07, g: 0.07, b: 0.07 },
  body:    { r: 0.2,  g: 0.2,  b: 0.2  },
  muted:   { r: 0.5,  g: 0.5,  b: 0.5  },
  accent:  { r: 0.09, g: 0.63, b: 0.98 },
  fail:    { r: 0.96, g: 0.26, b: 0.21 },
  warn:    { r: 1,    g: 0.76, b: 0    },
  pass:    { r: 0.3,  g: 0.69, b: 0.31 },
  divider: { r: 0.9,  g: 0.9,  b: 0.9  },
};

async function buildReportFrame(sourceFrame, findings, analysis) {
  await figma.loadFontAsync({ family: 'Inter', style: 'Bold' });
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' });

  const report = figma.createFrame();
  report.name = `utbot — ${sourceFrame.name}`;
  report.x = Math.round(sourceFrame.x + sourceFrame.width + 40);
  report.y = sourceFrame.y;
  report.layoutMode = 'VERTICAL';
  report.primaryAxisSizingMode = 'AUTO';
  report.counterAxisSizingMode = 'FIXED';
  report.resize(REPORT_WIDTH, 100);
  report.paddingTop = 40;
  report.paddingBottom = 40;
  report.paddingLeft = 40;
  report.paddingRight = 40;
  report.itemSpacing = 0;
  report.fills = [{ type: 'SOLID', color: COLORS.bg }];
  report.cornerRadius = 12;

  const addText = (parent, text, size, weight, color, fill = false) => {
    const t = figma.createText();
    parent.appendChild(t);
    t.fontName = { family: 'Inter', style: weight };
    t.fontSize = size;
    t.characters = text || ' ';
    t.fills = [{ type: 'SOLID', color }];
    t.textAutoResize = 'WIDTH_AND_HEIGHT';
    t.layoutSizingHorizontal = fill ? 'FILL' : 'HUG';
    return t;
  };

  const addSpacer = (parent, height) => {
    const f = figma.createFrame();
    parent.appendChild(f);
    f.resize(REPORT_WIDTH - 80, Math.max(1, height));
    f.fills = [];
    f.layoutSizingHorizontal = 'FILL';
    return f;
  };

  const addDivider = (parent) => {
    const d = figma.createFrame();
    parent.appendChild(d);
    d.resize(REPORT_WIDTH - 80, 1);
    d.fills = [{ type: 'SOLID', color: COLORS.divider }];
    d.layoutSizingHorizontal = 'FILL';
  };

  const addSection = (parent, title) => {
    addSpacer(parent, 28);
    addText(parent, title, 13, 'Bold', COLORS.accent, true);
    addSpacer(parent, 10);
  };

  const addScoreRow = (parent, label, score) => {
    const row = figma.createFrame();
    parent.appendChild(row);
    row.layoutMode = 'HORIZONTAL';
    row.primaryAxisSizingMode = 'FIXED';
    row.counterAxisSizingMode = 'AUTO';
    row.resize(REPORT_WIDTH - 80, 20);
    row.fills = [];
    row.itemSpacing = 12;
    row.layoutSizingHorizontal = 'FILL';

    const lbl = figma.createText();
    row.appendChild(lbl);
    lbl.fontName = { family: 'Inter', style: 'Regular' };
    lbl.fontSize = 13;
    lbl.characters = label;
    lbl.fills = [{ type: 'SOLID', color: COLORS.body }];
    lbl.textAutoResize = 'WIDTH_AND_HEIGHT';
    lbl.layoutSizingHorizontal = 'FILL';

    const clampedScore = Math.min(5, Math.max(1, score || 3));
    const stars = '★'.repeat(clampedScore) + '☆'.repeat(5 - clampedScore);
    const starsT = figma.createText();
    row.appendChild(starsT);
    starsT.fontName = { family: 'Inter', style: 'Regular' };
    starsT.fontSize = 13;
    starsT.characters = `${stars} (${clampedScore}/5)`;
    starsT.fills = [{
      type: 'SOLID',
      color: clampedScore >= 4 ? COLORS.pass : clampedScore >= 3 ? COLORS.warn : COLORS.fail,
    }];
    starsT.textAutoResize = 'WIDTH_AND_HEIGHT';

    addSpacer(parent, 8);
  };

  // 헤더
  addText(report, 'utbot 사용성 분석 리포트', 22, 'Bold', COLORS.title, true);
  addSpacer(report, 6);
  const date = new Date().toISOString().slice(0, 10);
  addText(report, `${sourceFrame.name}  ·  ${date}`, 12, 'Regular', COLORS.muted, true);

  // 규칙 기반 체크
  addSection(report, '규칙 기반 체크');
  addDivider(report);
  addSpacer(report, 12);

  if (findings.length === 0) {
    addText(report, '자동 감지된 문제 없음', 13, 'Regular', COLORS.pass, true);
  } else {
    for (const f of findings) {
      const icon = f.severity === 'fail' ? '[실패]' : '[경고]';
      addText(report, `${icon}  ${f.message}`, 12, 'Regular',
        f.severity === 'fail' ? COLORS.fail : COLORS.warn, true);
      addSpacer(report, 6);
    }
  }

  // 핵심 인사이트
  addSection(report, '핵심 인사이트');
  addDivider(report);
  addSpacer(report, 12);

  if (analysis.insights?.length) {
    for (const ins of analysis.insights) {
      addText(report, `• ${ins.content}`, 13, 'Bold', COLORS.title, true);
      addSpacer(report, 4);
      addText(report, ins.description, 12, 'Regular', COLORS.body, true);
      addSpacer(report, 2);
      addText(report, `→ ${ins.framework || ins.heuristic || ''}`, 11, 'Regular', COLORS.accent, true);
      addSpacer(report, 12);
    }
  }

  // 분석 섹션
  const sections = [
    ['기능 인지', analysis['기능인지']],
    ['과업 흐름', analysis['과업흐름']],
    ['탐색 유도', analysis['탐색유도']],
    ['오류 방지', analysis['오류방지']],
    ['시각 디자인', analysis['시각디자인']],
    ['감성 경험', analysis['감성경험']],
    ['접근성', analysis['접근성']],
  ];
  for (const [title, content] of sections) {
    addSection(report, title);
    addDivider(report);
    addSpacer(report, 10);
    addText(report, content || '—', 13, 'Regular', COLORS.body, true);
  }

  if (analysis['개선아이디어']) {
    addSection(report, '개선 아이디어');
    addDivider(report);
    addSpacer(report, 10);
    addText(report, analysis['개선아이디어'], 13, 'Regular', COLORS.body, true);
  }

  // 종합 평가
  addSection(report, '종합 평가');
  addDivider(report);
  addSpacer(report, 12);

  const scores = analysis.scores || {};
  const scoreKeys = [
    ['기능 인지', '기능인지'],
    ['과업 흐름', '과업흐름'],
    ['탐색 유도', '탐색유도'],
    ['오류 방지', '오류방지'],
    ['시각 디자인', '시각디자인'],
    ['감성 경험', '감성경험'],
    ['접근성', '접근성'],
    ['전체 사용성', '전체사용성'],
  ];
  for (const [label, key] of scoreKeys) {
    addScoreRow(report, label, scores[key]);
  }

  addSection(report, '총평');
  addDivider(report);
  addSpacer(report, 10);
  addText(report, analysis['총평'] || '—', 13, 'Regular', COLORS.body, true);

  figma.currentPage.appendChild(report);
  figma.currentPage.selection = [report];
  figma.viewport.scrollAndZoomIntoView([report]);
}

// ══════════════════════════════════════════════════════════════════
// [5] 메시지 핸들러 + 진입점
// ══════════════════════════════════════════════════════════════════

figma.showUI(__html__, { width: 280, height: 320 });

function getSelectedFrameName() {
  const sel = figma.currentPage.selection;
  if (sel.length === 1 && (sel[0].type === 'FRAME' || sel[0].type === 'COMPONENT')) {
    return sel[0].name;
  }
  return null;
}

async function init() {
  const key = await figma.clientStorage.getAsync('utbot-api-key');
  figma.ui.postMessage({
    type: 'init',
    hasKey: !!key,
    frameName: getSelectedFrameName(),
  });
}
init();

figma.on('selectionchange', () => {
  figma.ui.postMessage({
    type: 'selection-change',
    frameName: getSelectedFrameName(),
  });
});

figma.ui.onmessage = async (msg) => {
  if (msg.type === 'save-key') {
    await figma.clientStorage.setAsync('utbot-api-key', msg.key);
    figma.ui.postMessage({
      type: 'key-saved',
      frameName: getSelectedFrameName(),
    });
    return;
  }

  if (msg.type === 'analyze') {
    await runAnalysis();
  }
};

async function runAnalysis() {
  const sel = figma.currentPage.selection;
  if (sel.length !== 1 || (sel[0].type !== 'FRAME' && sel[0].type !== 'COMPONENT')) {
    figma.ui.postMessage({ type: 'error', message: '분석할 프레임을 하나만 선택해주세요.' });
    return;
  }

  const frame = sel[0];
  const apiKey = await figma.clientStorage.getAsync('utbot-api-key');
  if (!apiKey) {
    figma.ui.postMessage({ type: 'error', message: 'API 키가 없습니다. 키를 먼저 저장해주세요.' });
    return;
  }

  try {
    // 규칙 스캔
    figma.ui.postMessage({ type: 'progress', step: 'rules' });
    const findings = scanRules(frame);

    // 프레임 캡처
    figma.ui.postMessage({ type: 'progress', step: 'capture' });
    const uint8 = await frame.exportAsync({ format: 'PNG', constraint: { type: 'SCALE', value: 1 } });
    let binary = '';
    for (let i = 0; i < uint8.length; i++) binary += String.fromCharCode(uint8[i]);
    const base64 = btoa(binary);

    // Claude 분석
    figma.ui.postMessage({ type: 'progress', step: 'claude' });
    const analysis = await callClaude(apiKey, base64, findings, frame.name);

    // 리포트 생성
    figma.ui.postMessage({ type: 'progress', step: 'build' });
    await buildReportFrame(frame, findings, analysis);

    figma.ui.postMessage({ type: 'done' });
  } catch (e) {
    figma.ui.postMessage({ type: 'error', message: e.message || '알 수 없는 오류가 발생했습니다.' });
  }
}

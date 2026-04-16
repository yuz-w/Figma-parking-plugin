figma.showUI(__html__, { width: 320, height: 260 });

figma.ui.onmessage = async (msg) => {
  // ── URL 페치 (UI CSP 우회: code.js 샌드박스에서 실행) ─────────────────────
  if (msg.type === 'fetch-url') {
    const url = msg.url;
    const proxies = [
      `https://corsproxy.io/?${encodeURIComponent(url)}`,
      `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
    ];

    for (const proxyUrl of proxies) {
      try {
        const res = await fetch(proxyUrl);
        if (!res.ok) continue;
        const html = await res.text();
        figma.ui.postMessage({ type: 'fetch-result', success: true, html, url });
        return;
      } catch (e) {}
    }

    figma.ui.postMessage({ type: 'fetch-result', success: false });
    return;
  }

  if (msg.type !== 'draw-html') return;

  // ── 유틸 ──────────────────────────────────────────────────────────────────

  const safeSet = (node, prop, value) => {
    try { node[prop] = value; } catch (e) {}
  };

  const fixOpacity = (v) => {
    if (v == null) return 1;
    return Math.min(1, Math.max(0, v > 1 ? v / 100 : v));
  };

  // ── 폰트 로드 ─────────────────────────────────────────────────────────────
  const FONT_DEFS = [
    { family: 'Pretendard', style: 'ExtraBold' },
    { family: 'Pretendard', style: 'Bold'      },
    { family: 'Pretendard', style: 'SemiBold'  },
    { family: 'Pretendard', style: 'Medium'    },
    { family: 'Pretendard', style: 'Regular'   },
    { family: 'Noto Sans KR', style: 'Bold'    },
    { family: 'Noto Sans KR', style: 'Medium'  },
    { family: 'Noto Sans KR', style: 'Regular' },
    { family: 'Apple SD Gothic Neo', style: 'Bold'    },
    { family: 'Apple SD Gothic Neo', style: 'Medium'  },
    { family: 'Apple SD Gothic Neo', style: 'Regular' },
    { family: 'Inter', style: 'Bold'      },
    { family: 'Inter', style: 'Medium'    },
    { family: 'Inter', style: 'Regular'   },
  ];

  const loadedFonts = new Set();
  for (const f of FONT_DEFS) {
    try {
      await figma.loadFontAsync(f);
      loadedFonts.add(`${f.family}::${f.style}`);
    } catch (e) {}
  }

  const resolveFont = (weightRaw, preferFamily) => {
    const w = parseInt(weightRaw) || 400;
    const styles = w >= 800 ? ['ExtraBold', 'Bold', 'SemiBold', 'Medium', 'Regular']
                 : w >= 700 ? ['Bold', 'SemiBold', 'Medium', 'Regular']
                 : w >= 600 ? ['SemiBold', 'Bold', 'Medium', 'Regular']
                 : w >= 500 ? ['Medium', 'Regular', 'Bold']
                            : ['Regular', 'Medium', 'Bold'];
    const families = preferFamily
      ? [preferFamily, 'Pretendard', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Inter']
      : ['Pretendard', 'Noto Sans KR', 'Apple SD Gothic Neo', 'Inter'];
    for (const family of families) {
      for (const style of styles) {
        if (loadedFonts.has(`${family}::${style}`)) return { family, style };
      }
    }
    return { family: 'Inter', style: 'Regular' };
  };

  // ── 그림자 → Figma effects ─────────────────────────────────────────────────
  const toShadowEffects = (shadows) => {
    if (!shadows || shadows.length === 0) return null;
    const effects = [];
    for (const s of shadows) {
      if (s.inset) continue;
      effects.push({
        type:      'DROP_SHADOW',
        color:     { r: s.color.r, g: s.color.g, b: s.color.b, a: fixOpacity(s.color.a) },
        offset:    { x: s.x, y: s.y },
        radius:    Math.max(0, s.blur),
        spread:    s.spread || 0,
        visible:   true,
        blendMode: 'NORMAL',
      });
    }
    return effects.length > 0 ? effects : null;
  };

  // ── 이미지 base64 → Figma Image ───────────────────────────────────────────
  const toImageFill = (src) => {
    try {
      const base64 = src.split(',')[1];
      if (!base64) return null;
      const bytes = figma.base64Decode(base64);
      const img   = figma.createImage(bytes);
      return { type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' };
    } catch (e) { return null; }
  };

  // ── CSS → Figma 정렬 매핑 ────────────────────────────────────────────────
  const primaryAxisMap = {
    'flex-start': 'MIN', 'start': 'MIN', 'normal': 'MIN',
    'center':     'CENTER',
    'flex-end':   'MAX', 'end': 'MAX',
    'space-between': 'SPACE_BETWEEN',
    'space-around':  'SPACE_BETWEEN',
    'space-evenly':  'SPACE_BETWEEN',
    'baseline':      'MIN',
  };
  const counterAxisMap = {
    'flex-start': 'MIN', 'start': 'MIN', 'normal': 'MIN',
    'center':     'CENTER',
    'flex-end':   'MAX', 'end': 'MAX',
    'stretch':    'STRETCH',
    'baseline':   'MIN',
  };

  // ── 노드 빌드 ─────────────────────────────────────────────────────────────
  // 구조:
  //   body(root) → VERTICAL 오토레이아웃, 섹션들이 AUTO 모드로 세로 쌓임
  //   각 섹션     → FILL 너비 / FIXED 높이 (AUTO 모드, 절대좌표 없음)
  //   섹션 내부   → 절대좌표(ABSOLUTE) — 시각 정확도 최우선
  //   flex 컨테이너 → HORIZONTAL/VERTICAL + 자식 ABSOLUTE
  //
  // parentIsAutoLayout : 부모가 오토레이아웃 (x/y 전에 ABSOLUTE 먼저 설정)
  // parentIsBodyFlow   : 부모가 root body (섹션은 AUTO 모드로 흘러야 함)
  function buildNode(data, parent, parentX, parentY,
                     parentIsAutoLayout = false, parentIsBodyFlow = false) {
    if (!data) return null;

    // ── [1] 노드 생성 ─────────────────────────────────────────────────────────
    let node;
    if (data.type === 'IMAGE') {
      node = figma.createFrame();
    } else if (data.type === 'SVG') {
      try { node = figma.createNodeFromSvg(data.content); }
      catch (e) { node = figma.createFrame(); }
    } else if (data.type === 'TEXT') {
      node = figma.createText();
    } else {
      node = figma.createFrame();
    }

    // ── [2] 부모에 추가 ───────────────────────────────────────────────────────
    parent.appendChild(node);

    // ── [3] layoutPositioning ─────────────────────────────────────────────────
    // 오토레이아웃 부모의 자식: 절대좌표 유지를 위해 ABSOLUTE
    // 단, body flow의 직접 자식(섹션)은 AUTO로 흘러야 하므로 제외
    if (parentIsAutoLayout && !parentIsBodyFlow) {
      safeSet(node, 'layoutPositioning', 'ABSOLUTE');
    }

    // =========================================================================
    // ── FRAME / IMAGE / SVG ───────────────────────────────────────────────────
    // =========================================================================
    if (node.type === 'FRAME') {
      node.name = data.tag || data.type || 'div';

      // ── [4] layoutMode ────────────────────────────────────────────────────
      const isRootBody   = (parent.type === 'PAGE');
      const isFlex       = data.display === 'flex' || data.display === 'inline-flex';
      const layoutMode   = isRootBody
        ? 'VERTICAL'   // body는 무조건 VERTICAL (섹션 세로 쌓기)
        : isFlex
          ? (data.flexDirection === 'column' || data.flexDirection === 'column-reverse'
              ? 'VERTICAL' : 'HORIZONTAL')
          : 'NONE';
      node.layoutMode = layoutMode;

      // ── [5] 오토레이아웃 속성 ────────────────────────────────────────────
      if (layoutMode !== 'NONE') {
        safeSet(node, 'primaryAxisSizingMode', 'FIXED');
        safeSet(node, 'counterAxisSizingMode', 'FIXED');

        if (isRootBody) {
          // body: 섹션들이 딱 붙어 쌓임 (margin 없음)
          safeSet(node, 'itemSpacing', 0);
          safeSet(node, 'paddingTop',    0);
          safeSet(node, 'paddingRight',  0);
          safeSet(node, 'paddingBottom', 0);
          safeSet(node, 'paddingLeft',   0);
          safeSet(node, 'primaryAxisAlignItems', 'MIN');
          safeSet(node, 'counterAxisAlignItems', 'MIN');
        } else {
          // flex 컨테이너: CSS 속성 그대로
          safeSet(node, 'paddingTop',    Math.round(data.paddingTop    || 0));
          safeSet(node, 'paddingRight',  Math.round(data.paddingRight  || 0));
          safeSet(node, 'paddingBottom', Math.round(data.paddingBottom || 0));
          safeSet(node, 'paddingLeft',   Math.round(data.paddingLeft   || 0));
          const gap = layoutMode === 'VERTICAL'
            ? (data.rowGap    || data.gap || 0)
            : (data.columnGap || data.gap || 0);
          safeSet(node, 'itemSpacing', Math.round(gap));
          safeSet(node, 'primaryAxisAlignItems',
            primaryAxisMap[data.justifyContent] || 'MIN');
          safeSet(node, 'counterAxisAlignItems',
            counterAxisMap[data.alignItems] || 'MIN');
        }
      }

      node.clipsContent = data.overflow === 'hidden' || data.overflow === 'clip';

      // ── [6] 위치 ─────────────────────────────────────────────────────────
      // body flow 자식(섹션)은 오토레이아웃이 y를 결정하므로 x/y 생략
      if (!parentIsBodyFlow) {
        node.x = Math.round((data.x || 0) - parentX);
        node.y = Math.round((data.y || 0) - parentY);
      }

      // ── [7] 크기 ──────────────────────────────────────────────────────────
      const w = Math.max(1, Math.round(data.w || 1));
      const h = Math.max(1, Math.round(data.h || 1));
      try { node.resize(w, h); } catch (e) {}

      // 섹션은 가로 FILL (body 너비 꽉 채움), 세로 FIXED (HTML 높이 그대로)
      if (parentIsBodyFlow) {
        safeSet(node, 'layoutSizingHorizontal', 'FILL');
        safeSet(node, 'layoutSizingVertical',   'FIXED');
      }

      // ── [8] 채우기 / 테두리 / 효과 ───────────────────────────────────────
      if (data.type === 'IMAGE' && data.src) {
        const fill = toImageFill(data.src);
        node.fills = fill
          ? [fill]
          : [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 }, opacity: 1 }];
      } else if (data.bg) {
        node.fills = [{
          type: 'SOLID',
          color: { r: data.bg.r, g: data.bg.g, b: data.bg.b },
          opacity: fixOpacity(data.bg.a),
        }];
      } else {
        node.fills = [];
      }

      if (data.border && data.bw > 0) {
        safeSet(node, 'strokes', [{
          type: 'SOLID',
          color: { r: data.border.r, g: data.border.g, b: data.border.b },
          opacity: fixOpacity(data.border.a),
        }]);
        safeSet(node, 'strokeWeight', data.bw);
        safeSet(node, 'strokeAlign', 'INSIDE');
      }

      safeSet(node, 'cornerRadius', Math.round(data.radius || 0));

      const effects = toShadowEffects(data.shadows);
      if (effects) safeSet(node, 'effects', effects);

      if (data.opacity != null && data.opacity < 1) {
        safeSet(node, 'opacity', fixOpacity(data.opacity));
      }
    }

    // =========================================================================
    // ── TEXT ──────────────────────────────────────────────────────────────────
    // =========================================================================
    if (node.type === 'TEXT') {
      const fontName = resolveFont(data.fontWeight, data.fontFamily);
      safeSet(node, 'fontName', fontName);
      safeSet(node, 'fontSize', Math.max(1, data.fontSize || 16));
      safeSet(node, 'characters', data.text || ' ');

      if (data.isBlockText) {
        // p/li 등 블록 텍스트: 부모 너비 고정 + HEIGHT 자동 (줄바꿈 허용)
        safeSet(node, 'textAutoResize', 'HEIGHT');
        if (data.w > 0) {
          try { node.resize(Math.max(1, Math.round(data.w)), Math.max(1, Math.round(data.h || 20))); } catch(e) {}
        }
      } else {
        // 제목/레이블 등: WIDTH_AND_HEIGHT(HUG) → 줄바꿈 없이 내용에 맞게 자동 크기
        safeSet(node, 'textAutoResize', 'WIDTH_AND_HEIGHT');
      }

      if (data.color) {
        node.fills = [{
          type: 'SOLID',
          color: { r: data.color.r, g: data.color.g, b: data.color.b },
          opacity: fixOpacity(data.color.a),
        }];
      }

      const alignMap = { left: 'LEFT', center: 'CENTER', right: 'RIGHT', justify: 'JUSTIFIED' };
      safeSet(node, 'textAlignHorizontal', alignMap[data.textAlign] || 'LEFT');

      if (data.lineHeight && data.lineHeight !== 'normal') {
        const lhPx = parseFloat(data.lineHeight);
        if (lhPx > 0) safeSet(node, 'lineHeight', { value: lhPx, unit: 'PIXELS' });
      } else {
        safeSet(node, 'lineHeight', { unit: 'AUTO' });
      }

      if (data.letterSpacing && data.letterSpacing !== 'normal') {
        const lsPx = parseFloat(data.letterSpacing);
        if (!isNaN(lsPx)) safeSet(node, 'letterSpacing', { value: lsPx, unit: 'PIXELS' });
      }

      if (!parentIsBodyFlow) {
        node.x = Math.round((data.x || 0) - parentX);
        node.y = Math.round((data.y || 0) - parentY);
      }

      if (data.opacity != null && data.opacity < 1) {
        safeSet(node, 'opacity', fixOpacity(data.opacity));
      }
    }

    // ── [9] 자식 재귀 ─────────────────────────────────────────────────────────
    if (data.type !== 'IMAGE' && data.children) {
      const myIsAutoLayout = (node.type === 'FRAME') && (node.layoutMode !== 'NONE');
      // body의 자식들(섹션)에게 isBodyFlow=true 전달
      const isBodyFrame    = (parent.type === 'PAGE');

      for (const child of data.children) {
        buildNode(child, node, data.x || 0, data.y || 0, myIsAutoLayout, isBodyFrame);
      }
    }

    return node;
  }

  // ── 실행 ──────────────────────────────────────────────────────────────────
  const rootNode = buildNode(msg.data, figma.currentPage, 0, 0);
  if (rootNode) {
    figma.currentPage.selection = [rootNode];
    figma.viewport.scrollAndZoomIntoView([rootNode]);
  }
};

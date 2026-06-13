import type { TemplateId } from "../core/storyboard";

export interface TemplateDefinition {
  id: TemplateId;
  name: string;
  purpose: string;
  base: {
    required?: string[];
    allowed: string[];
  };
  stepState: {
    allowed: string[];
  };
  stepShow: {
    allowed: string[];
  };
  constraints?: {
    maxCenterItemsPerStep?: number;
    maxAuxItemsPerStep?: number;
    maxTextChars?: number;
    maxGlyphLines?: number;
    maxGlyphCharsPerLine?: number;
  };
  capacity?: {
    area: "none" | "aux" | "center" | "glyph";
    basis: string;
    perStep?: Record<string, number>;
    perBeat?: Record<string, number>;
  };
}

export const TEMPLATE_REGISTRY: Record<TemplateId, TemplateDefinition> = {
  T0: {
    id: "T0",
    name: "开场字幕",
    purpose: "卷轴/白板就绪前的片头引入，只显示字幕。",
    base: { allowed: [] },
    stepState: { allowed: [] },
    stepShow: { allowed: [] },
    capacity: {
      area: "none",
      basis: "T0 不进入白板空间，只显示字幕。",
      perBeat: { maxWhiteboardItems: 0 },
    },
  },
  T1: {
    id: "T1",
    name: "原文 + 渐进注释",
    purpose: "逐句精讲。右侧经文先出现，highlight 与左侧注释按 step 推进。",
    base: { required: ["sent"], allowed: ["sent", "hi", "aux"] },
    stepState: { allowed: ["sent", "hi"] },
    stepShow: { allowed: ["aux"] },
    constraints: {
      maxAuxItemsPerStep: 2,
      maxTextChars: 22,
    },
    capacity: {
      area: "aux",
      basis: "道德经/水墨卷轴 1280x720；board=48.5%x37%；aux=42%x94%；当前 --jing-size=2cqw。",
      perStep: { maxNewAuxItems: 2, maxTextChars: 22, maxVisualLines: 2 },
      perBeat: { maxSteps: 3, maxAuxItems: 6, maxHeadItems: 1, maxGlossItems: 2, maxPointItems: 3, maxTextChars: 64, maxVisualLines: 6 },
    },
  },
  T2: {
    id: "T2",
    name: "标题 + 引",
    purpose: "引子、过渡、结构转场。标题先出，引句/结构提示逐步出现。",
    base: { allowed: ["title"] },
    stepState: { allowed: [] },
    stepShow: { allowed: ["center", "lead", "note", "title"] },
    constraints: {
      maxCenterItemsPerStep: 2,
      maxTextChars: 22,
    },
    capacity: {
      area: "center",
      basis: "道德经/水墨卷轴 1280x720；center 使用完整 board，左右内缩 6%。",
      perStep: { maxNewCenterItems: 1, maxTextChars: 24, maxVisualLines: 2 },
      perBeat: { maxSteps: 3, maxCenterItems: 3, maxTitleItems: 1, maxLeadItems: 2, maxTextChars: 64, maxVisualLines: 5 },
    },
  },
  T3: {
    id: "T3",
    name: "中央大字",
    purpose: "题眼、核心字、卷轴揭开后的视觉锤点。",
    base: { required: ["glyph"], allowed: ["glyph"] },
    stepState: { allowed: [] },
    stepShow: { allowed: [] },
    constraints: {
      maxGlyphLines: 2,
      maxGlyphCharsPerLine: 4,
    },
    capacity: {
      area: "glyph",
      basis: "道德经/水墨卷轴当前 --glyph-size=6cqw。",
      perBeat: { maxGlyphLines: 2, maxGlyphCharsPerLine: 4, maxWhiteboardItems: 1 },
    },
  },
  T4: {
    id: "T4",
    name: "收束一句话",
    purpose: "收束、反问、金句。按分句或关键词渐进出现。",
    base: { allowed: ["big"] },
    stepState: { allowed: [] },
    stepShow: { allowed: ["center", "big"] },
    constraints: {
      maxCenterItemsPerStep: 1,
      maxTextChars: 24,
    },
    capacity: {
      area: "center",
      basis: "道德经/水墨卷轴 1280x720；big 文本使用完整 board，适合一句收束。",
      perStep: { maxNewBigItems: 1, maxTextChars: 32, maxVisualLines: 3 },
      perBeat: { maxSteps: 1, maxBigItems: 1, maxTextChars: 36, maxVisualLines: 3 },
    },
  },
};

export function getTemplateDefinition(id: string): TemplateDefinition | undefined {
  return TEMPLATE_REGISTRY[id as TemplateId];
}

export function isTemplateId(id: string): id is TemplateId {
  return Object.prototype.hasOwnProperty.call(TEMPLATE_REGISTRY, id);
}

export function templateIds(): TemplateId[] {
  return Object.keys(TEMPLATE_REGISTRY) as TemplateId[];
}

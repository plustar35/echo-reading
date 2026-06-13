export type TemplateId = "T0" | "T1" | "T2" | "T3" | "T4";

export type Highlight = string[] | "sweep";

export interface JingPartText {
  k: string;
  t: string;
}

export interface JingPartPunc {
  p: string;
}

export type JingPart = JingPartText | JingPartPunc;

export interface JingSentence {
  id: string;
  parts: JingPart[];
}

export interface Atom {
  id: string;
  narr: string;
}

export interface AuxHead {
  kind: "head";
  text: string;
}

export interface AuxGloss {
  kind: "gloss";
  z: string;
  p?: string;
  m: string;
}

export interface AuxPoint {
  kind: "point";
  text: string;
}

export type AuxItem = AuxHead | AuxGloss | AuxPoint;

export interface CenterItem {
  kind: "title" | "lead" | "glyph" | "note" | "big";
  text: string;
}

export interface StepState {
  sent?: string;
  hi?: Highlight;
}

export interface StepShow {
  aux?: AuxItem[];
  center?: CenterItem[];
  title?: string;
  glyph?: string;
  lead?: string[];
  note?: string;
  big?: string | string[];
}

export interface Step {
  take: string[];
  state?: StepState;
  show?: StepShow;
}

export interface BeatBase {
  sent?: string;
  hi?: Highlight;
  aux?: AuxItem[];
  title?: string;
  glyph?: string;
  lead?: string[];
  big?: string;
}

export interface Beat {
  seg: string;
  tpl: TemplateId;
  take: string[];
  narr?: string;
  base?: BeatBase;

  // Deprecated old format: atoms now live at STORYBOARD.atoms.
  atoms?: Atom[];
  steps?: Step[];

  // Legacy fields kept for old storyboards.
  sent?: string;
  hi?: Highlight;
  aux?: unknown;
  title?: string;
  glyph?: string;
  lead?: string[];
  big?: string;
}

export interface Storyboard {
  book: string;
  chapter: string;
  assets?: string;
  scrollTitle: string;
  audio: string;
  jing: JingSentence[];
  atoms: Atom[];
  beats: Beat[];
  durs?: number[];
  stepDurs?: number[][];
  scrollReadyMs?: number;
  introVideoMs?: number;
}

export interface TimelineCue {
  t: string;
  startMs: number;
  endMs: number;
  word?: boolean;
}

export interface TimelineBlock {
  idx: number;
  text: string;
  startMs: number;
  endMs: number;
}

export interface Timeline {
  totalMs: number;
  scrollReadyMs?: number;
  narrHash?: string;
  engine?: string;
  voice?: string;
  rate?: string;
  granularity?: "sentence" | "word" | "block";
  cues?: TimelineCue[];
  blocks?: TimelineBlock[];
}

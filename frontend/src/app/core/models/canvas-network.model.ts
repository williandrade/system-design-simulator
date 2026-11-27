export type NetworkFrameKind = 'vpc' | 'az' | 'subnet';

export interface NetworkFrame {
  id: string;
  kind: NetworkFrameKind;
  name: string;
  x: number;
  y: number;
  width: number;
  height: number;
  parentId?: string;
}

export interface NetworkArrow {
  id: string;
  sourceId: string;
  targetId: string;
  label?: string;
}

/** Diagram-only elements. Node coordinates are always in canvas space. */
export interface CanvasNetwork {
  frames: NetworkFrame[];
  arrows: NetworkArrow[];
  nodeParents: Record<string, string>;
}

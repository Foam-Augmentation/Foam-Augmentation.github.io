// src/types/clipper-lib.d.ts

declare namespace ClipperLib {
  interface IntPoint { X: number; Y: number; }

  type Path = IntPoint[];
  type Paths = Path[];

  enum JoinType { jtSquare, jtRound, jtMiter }
  enum EndType { etClosedPolygon, etClosedLine, etOpenButt, etOpenSquare, etOpenRound }

  class ClipperOffset {
    static def_arc_tolerance: number;
    constructor(miterLimit?: number, arcTolerance?: number);
    Clear(): void;
    AddPath(path: Path, joinType: JoinType, endType: EndType): void;
    Execute(solution: Paths, delta: number): void;
  }
}

declare module 'clipper-lib' {
  export = ClipperLib;
}

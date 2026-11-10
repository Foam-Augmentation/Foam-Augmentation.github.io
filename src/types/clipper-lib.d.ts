// src/types/clipper-lib.d.ts
//
// Hand-written typings for the parts of clipper-lib that the slicer uses. The enum values are
// written out explicitly so that they match the library's runtime values (see clipper.js).

declare namespace ClipperLib {
  interface IntPoint { X: number; Y: number; }

  type Path = IntPoint[];
  type Paths = Path[];

  enum ClipType { ctIntersection = 0, ctUnion = 1, ctDifference = 2, ctXor = 3 }
  enum PolyType { ptSubject = 0, ptClip = 1 }
  enum PolyFillType { pftEvenOdd = 0, pftNonZero = 1, pftPositive = 2, pftNegative = 3 }
  enum JoinType { jtSquare = 0, jtRound = 1, jtMiter = 2 }
  enum EndType { etOpenSquare = 0, etOpenRound = 1, etOpenButt = 2, etClosedLine = 3, etClosedPolygon = 4 }

  class Clipper {
    constructor(initOptions?: number);
    AddPath(path: Path, polyType: PolyType, closed: boolean): boolean;
    AddPaths(paths: Paths, polyType: PolyType, closed: boolean): boolean;
    Execute(
      clipType: ClipType,
      solution: Paths,
      subjFillType?: PolyFillType,
      clipFillType?: PolyFillType
    ): boolean;
  }

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

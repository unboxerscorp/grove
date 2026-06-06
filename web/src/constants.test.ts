import { describe, expect, it } from "vitest";

import { boardBucket } from "./constants";

// boardBucket maps an ALREADY-canonical status (+ needs_human) to one of the
// three operator lists: the two active human lists (todo, ask_human) and the
// separated archive (done/archived). Archive wins over ask_human so a completed
// task never lingers in the human-decision list.
describe("boardBucket", () => {
  it("routes done + archived to the archive", () => {
    expect(boardBucket("done", false)).toBe("archive");
    expect(boardBucket("archived", false)).toBe("archive");
  });

  it("archive wins over needs_human", () => {
    expect(boardBucket("done", true)).toBe("archive");
    expect(boardBucket("archived", true)).toBe("archive");
  });

  it("routes ask_human and needs_human to the human-decision list", () => {
    expect(boardBucket("ask_human", false)).toBe("ask_human");
    expect(boardBucket("blocked", true)).toBe("ask_human");
    expect(boardBucket("review", true)).toBe("ask_human");
  });

  it("routes every other active status to todo", () => {
    expect(boardBucket("ready", false)).toBe("todo");
    expect(boardBucket("running", false)).toBe("todo");
    expect(boardBucket("review", false)).toBe("todo");
    expect(boardBucket("blocked", false)).toBe("todo");
  });
});

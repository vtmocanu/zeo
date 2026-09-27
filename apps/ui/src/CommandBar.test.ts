import { describe, expect, test } from "vitest";
import { subscribeViewportSize, type ViewportTarget } from "./CommandBar.js";

class FakeViewport extends EventTarget implements ViewportTarget {
  innerWidth = 360;
  innerHeight = 44;
  resize(width: number, height: number): void {
    this.innerWidth = width;
    this.innerHeight = height;
    this.dispatchEvent(new Event("resize"));
  }
}

describe("subscribeViewportSize", () => {
  test("reports the size at subscribe time, catching a resize that fired before it", () => {
    const target = new FakeViewport();
    // A resize before anyone listens: the overlay grew to the full window
    // between the first render and the effect.
    target.resize(1280, 800);
    const sizes: { width: number; height: number }[] = [];
    subscribeViewportSize(target, (s) => sizes.push(s));
    expect(sizes).toEqual([{ width: 1280, height: 800 }]);
  });

  test("reports later resizes until unsubscribed", () => {
    const target = new FakeViewport();
    const sizes: { width: number; height: number }[] = [];
    const unsubscribe = subscribeViewportSize(target, (s) => sizes.push(s));
    target.resize(1280, 800);
    unsubscribe();
    target.resize(900, 600);
    expect(sizes).toEqual([
      { width: 360, height: 44 },
      { width: 1280, height: 800 },
    ]);
  });
});
